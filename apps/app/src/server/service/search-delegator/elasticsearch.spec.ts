import mongoose from 'mongoose';
import { vi } from 'vitest';
import { type MockProxy, mock } from 'vitest-mock-extended';

import type { ActivityDocument } from '~/server/models/activity';
import { configManager } from '~/server/service/config-manager';
import type { SocketIoService } from '~/server/service/socket-io';

import ElasticsearchDelegator from './elasticsearch';
import type { ElasticsearchClientDelegator } from './elasticsearch-client-delegator';
import type { ES7ClientDelegator } from './elasticsearch-client-delegator/es7-client-delegator';
import type { ES8ClientDelegator } from './elasticsearch-client-delegator/es8-client-delegator';

const { mockError } = vi.hoisted(() => ({
  mockError: vi.fn(),
}));

vi.mock('~/utils/logger', () => ({
  default: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockError,
  })),
}));

vi.mock('~/server/service/config-manager', () => ({
  configManager: { getConfig: vi.fn() },
}));

// type-assertion (unavoidable): no public seam to set the version-specific client.
const injectClient = (
  target: ElasticsearchDelegator,
  client: ElasticsearchClientDelegator,
) => {
  (target as unknown as { client: ElasticsearchClientDelegator }).client =
    client;
};

describe('ElasticsearchDelegator', () => {
  let delegator: ElasticsearchDelegator;
  let mockSocketIo: MockProxy<SocketIoService>;
  let mockClient: { delegatorVersion: 8; bulk: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(configManager.getConfig).mockImplementation((key) => {
      if (key === 'app:elasticsearchVersion') return 8;
      return false;
    });

    mockSocketIo = mock<SocketIoService>();
    delegator = new ElasticsearchDelegator(mockSocketIo);

    mockClient = {
      delegatorVersion: 8,
      bulk: vi.fn().mockResolvedValue({ errors: false, items: [] }),
    };
    (delegator as unknown as { client: ElasticsearchClientDelegator }).client =
      mockClient as unknown as ElasticsearchClientDelegator;
  });

  describe('updateOrInsertAuditlog()', () => {
    it('should not call bulk when activity is null', async () => {
      await delegator.updateOrInsertAuditlog(null);

      expect(mockClient.bulk).not.toHaveBeenCalled();
    });

    it('should not call bulk when snapshot.username is null', async () => {
      const activity = {
        _id: new mongoose.Types.ObjectId(),
        snapshot: { username: null },
      } as unknown as ActivityDocument;

      await delegator.updateOrInsertAuditlog(activity);

      expect(mockClient.bulk).not.toHaveBeenCalled();
    });

    it('should not call bulk when snapshot.username is empty string', async () => {
      const activity = {
        _id: new mongoose.Types.ObjectId(),
        snapshot: { username: '' },
      } as unknown as ActivityDocument;

      await delegator.updateOrInsertAuditlog(activity);

      expect(mockClient.bulk).not.toHaveBeenCalled();
    });

    it('should call bulk with correct body for valid activity', async () => {
      const id = new mongoose.Types.ObjectId();
      const activity = {
        _id: id,
        snapshot: { username: 'test-user' },
      } as unknown as ActivityDocument;

      await delegator.updateOrInsertAuditlog(activity);

      expect(mockClient.bulk).toHaveBeenCalledWith({
        body: [
          { index: { _index: 'auditlogs-alias', _id: id.toString() } },
          { username: 'test-user' },
        ],
      });
    });

    it('should call logger.error when bulk response has errors', async () => {
      const activity = {
        _id: new mongoose.Types.ObjectId(),
        snapshot: { username: 'test-user' },
      } as unknown as ActivityDocument;

      mockClient.bulk.mockResolvedValue({
        errors: true,
        items: [
          { index: { error: { type: 'mapper_exception', reason: 'failed' } } },
        ],
      });

      await delegator.updateOrInsertAuditlog(activity);

      expect(mockError).toHaveBeenCalledWith(
        expect.objectContaining({ failedItems: expect.any(Array) }),
        'updateOrInsertAuditlog bulk indexing had errors',
      );
    });

    it('should call logger.error and not throw when bulk throws', async () => {
      const activity = {
        _id: new mongoose.Types.ObjectId(),
        snapshot: { username: 'test-user' },
      } as unknown as ActivityDocument;

      mockClient.bulk.mockRejectedValue(new Error('ES connection error'));

      await expect(
        delegator.updateOrInsertAuditlog(activity),
      ).resolves.toBeUndefined();
      expect(mockError).toHaveBeenCalledWith(
        'updateOrInsertAuditlog failed.',
        expect.any(Error),
      );
    });
  });

  describe('searchAuditlogByFuzzyWildcard()', () => {
    const makeBuckets = (keys: string[]) =>
      keys.map((key) => ({ key, doc_count: 1 }));

    describe('ES8/9 path', () => {
      let mockES8Client: MockProxy<ES8ClientDelegator>;

      beforeEach(() => {
        mockES8Client = mock<ES8ClientDelegator>({ delegatorVersion: 8 });
        // type-assertion (unavoidable): ES search response is a huge union; cast minimal shape.
        mockES8Client.search.mockResolvedValue({
          aggregations: {
            unique_values: { buckets: makeBuckets(['alice', 'bob']) },
          },
        } as unknown as Awaited<ReturnType<typeof mockES8Client.search>>);
        injectClient(delegator, mockES8Client);
      });

      it('should escape *, ?, \\ in query', async () => {
        await delegator.searchAuditlogByFuzzyWildcard(
          'username',
          'a*b?c\\d',
          10,
        );

        expect(mockES8Client.search).toHaveBeenCalledWith(
          expect.objectContaining({
            query: expect.objectContaining({
              bool: expect.objectContaining({
                should: expect.arrayContaining([
                  expect.objectContaining({
                    wildcard: expect.objectContaining({
                      username: expect.objectContaining({
                        value: 'a\\*b\\?c\\\\d*',
                        case_insensitive: true,
                      }),
                    }),
                  }),
                  expect.objectContaining({
                    fuzzy: expect.objectContaining({
                      username: expect.objectContaining({
                        value: 'a\\*b\\?c\\\\d',
                        fuzziness: 'AUTO',
                      }),
                    }),
                  }),
                ]),
              }),
            }),
          }),
        );
      });

      it('should use auditlogs-alias as index', async () => {
        await delegator.searchAuditlogByFuzzyWildcard('username', 'alice', 10);

        expect(mockES8Client.search).toHaveBeenCalledWith(
          expect.objectContaining({ index: 'auditlogs-alias' }),
        );
      });

      it('should use flat format without body wrapper', async () => {
        await delegator.searchAuditlogByFuzzyWildcard('username', 'alice', 10);

        expect(mockES8Client.search).toHaveBeenCalledWith(
          expect.objectContaining({ size: 0 }),
        );
        expect(mockES8Client.search).not.toHaveBeenCalledWith(
          expect.objectContaining({ body: expect.anything() }),
        );
      });

      it('should pass limit to terms.size', async () => {
        await delegator.searchAuditlogByFuzzyWildcard('username', 'alice', 5);

        expect(mockES8Client.search).toHaveBeenCalledWith(
          expect.objectContaining({
            aggs: expect.objectContaining({
              unique_values: expect.objectContaining({
                terms: expect.objectContaining({ size: 5 }),
              }),
            }),
          }),
        );
      });

      it('should return bucket keys as string array', async () => {
        const result = await delegator.searchAuditlogByFuzzyWildcard(
          'username',
          'alice',
          10,
        );

        expect(result).toEqual(['alice', 'bob']);
      });

      it('should return [] when rawBuckets is not an array', async () => {
        // type-assertion (unavoidable): invalid buckets on purpose to hit the non-array guard.
        mockES8Client.search.mockResolvedValue({
          aggregations: { unique_values: { buckets: 'invalid' } },
        } as unknown as Awaited<ReturnType<typeof mockES8Client.search>>);

        const result = await delegator.searchAuditlogByFuzzyWildcard(
          'username',
          'alice',
          10,
        );

        expect(result).toEqual([]);
      });
    });

    describe('ES7 path', () => {
      let mockES7Client: MockProxy<ES7ClientDelegator>;

      beforeEach(() => {
        mockES7Client = mock<ES7ClientDelegator>({ delegatorVersion: 7 });
        // type-assertion (unavoidable): see ES8 path — ES response is a large union.
        mockES7Client.search.mockResolvedValue({
          aggregations: {
            unique_values: { buckets: makeBuckets(['alice']) },
          },
        } as unknown as Awaited<ReturnType<typeof mockES7Client.search>>);
        injectClient(delegator, mockES7Client);
      });

      it('should use auditlogs-alias as index', async () => {
        await delegator.searchAuditlogByFuzzyWildcard('username', 'alice', 10);

        expect(mockES7Client.search).toHaveBeenCalledWith(
          expect.objectContaining({ index: 'auditlogs-alias' }),
        );
      });

      it('should use body wrapper format', async () => {
        await delegator.searchAuditlogByFuzzyWildcard('username', 'alice', 10);

        expect(mockES7Client.search).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              size: 0,
              aggs: expect.objectContaining({
                unique_values: expect.objectContaining({
                  terms: expect.objectContaining({ field: 'username' }),
                }),
              }),
            }),
          }),
        );
      });

      it('should pass limit to terms.size', async () => {
        await delegator.searchAuditlogByFuzzyWildcard('username', 'alice', 5);

        expect(mockES7Client.search).toHaveBeenCalledWith(
          expect.objectContaining({
            body: expect.objectContaining({
              aggs: expect.objectContaining({
                unique_values: expect.objectContaining({
                  terms: expect.objectContaining({ size: 5 }),
                }),
              }),
            }),
          }),
        );
      });

      it('should return bucket keys as string array', async () => {
        const result = await delegator.searchAuditlogByFuzzyWildcard(
          'username',
          'alice',
          10,
        );

        expect(result).toEqual(['alice']);
      });
    });

    describe('unknown client type', () => {
      beforeEach(() => {
        // type-assertion (unavoidable): 0 is outside the 7|8|9 union, to hit the fallback.
        injectClient(delegator, {
          delegatorVersion: 0,
        } as unknown as ElasticsearchClientDelegator);
      });

      it('should return []', async () => {
        const result = await delegator.searchAuditlogByFuzzyWildcard(
          'username',
          'alice',
          10,
        );

        expect(result).toEqual([]);
      });
    });
  });
});
