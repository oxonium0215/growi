import { useCallback, useEffect } from 'react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import type { Socket } from 'socket.io-client';

import { SocketEventName } from '~/interfaces/websocket';
import { useCurrentPageId } from '~/states/page';
import loggerFactory from '~/utils/logger';

import { useIsGuestUser } from '../context';

const logger = loggerFactory('growi:states:websocket');

// Constants
export const GLOBAL_SOCKET_NS = '/';

// WebSocket connection atom
const globalSocketAtom = atom<Socket | null>(null);

/**
 * Hook to get WebSocket connection
 */
export const useGlobalSocket = (): Socket | null =>
  useAtomValue(globalSocketAtom);

/**
 * Hook to initialize WebSocket connection
 * Alternative to useSetupGlobalSocket
 */
export const useSetupGlobalSocket = (): void => {
  const setSocket = useSetAtom(globalSocketAtom);
  const socket = useAtomValue(globalSocketAtom);

  const isGuestUser = useIsGuestUser();

  const initializeSocket = useCallback(async () => {
    try {
      // Dynamic import of socket.io-client
      const { io } = await import('socket.io-client');
      const newSocket = io(GLOBAL_SOCKET_NS, {
        transports: ['websocket'],
      });

      // Error handling
      newSocket.on('error', (err) => {
        logger.error({ err }, 'Socket error');
      });
      newSocket.on('connect_error', (err) => {
        logger.error({ err }, 'Failed to connect with websocket.');
      });

      // Store connection in atom
      setSocket(newSocket);
    } catch (error) {
      logger.error({ err: error }, 'Failed to initialize WebSocket');
    }
  }, [setSocket]);

  useEffect(() => {
    if (!isGuestUser && socket == null) {
      initializeSocket();
    }
  }, [isGuestUser, socket, initializeSocket]);
};

/**
 * Hook for page-specific WebSocket room management
 * Alternative to useSetupGlobalSocketForPage
 */
export const useSetupGlobalSocketForPage = (): void => {
  const socket = useAtomValue(globalSocketAtom);
  const pageId = useCurrentPageId(true);

  useEffect(() => {
    if (socket == null || pageId == null) {
      return;
    }

    socket.emit(SocketEventName.JoinPage, { pageId });

    // Re-emit JoinPage on auto-reconnect to restore page room subscription.
    // socket.io reconnects internally, reusing the same socket instance,
    // so this effect's dependency array won't re-trigger. The explicit
    // 'connect' listener ensures the room is re-joined after reconnection.
    const handleConnect = () => {
      socket.emit(SocketEventName.JoinPage, { pageId });
    };
    socket.on('connect', handleConnect);

    return () => {
      socket.off('connect', handleConnect);
      socket.emit(SocketEventName.LeavePage, { pageId });
    };
  }, [pageId, socket]);
};
