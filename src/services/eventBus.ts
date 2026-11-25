import { EventEmitter } from 'node:events';

export type AppEventType =
  | 'batch.updated'
  | 'batches.cleared'
  | 'outbound.updated'
  | 'message.received'
  | 'message.sent'
  | 'messages.cleared'
  | 'session.status'
  | 'worker.status';

export interface AppEvent<T = unknown> {
  type: AppEventType;
  timestamp: string;
  data: T;
}

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  emit<T>(type: AppEventType, data: T): void {
    const payload: AppEvent<T> = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    this.emitter.emit('app-event', payload);
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.emitter.on('app-event', listener);
    return () => {
      this.emitter.off('app-event', listener);
    };
  }
}
