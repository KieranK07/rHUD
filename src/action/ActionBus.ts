/**
 * Named events the HUD emits when gestures resolve.
 *
 * Deliberately a stub: nothing external is wired up yet. The point is that
 * gestures already speak in intents ('menu.open') rather than raw poses
 * ('left hand pinched'), so connecting real targets later means writing one
 * sink, not rewriting the gesture layer.
 */

import type { Chirality } from '../input/HandSource.ts';

export type ActionType =
  | 'pinch.start'
  | 'pinch.end'
  | 'fist.start'
  | 'fist.end'
  | 'open.start'
  | 'open.end'
  | 'point.start'
  | 'point.end';

export interface Action {
  type: ActionType;
  hand: Chirality;
  /** performance.now() at emission. */
  t: number;
  /** Gesture-specific payload — pinch strength, pointing direction, etc. */
  data?: Record<string, number>;
}

export type ActionSink = (action: Action) => void;

export class ActionBus {
  private sinks: ActionSink[] = [];
  private listeners = new Map<ActionType, ActionSink[]>();

  /** Receives every action. */
  pipe(sink: ActionSink): () => void {
    this.sinks.push(sink);
    return () => {
      this.sinks = this.sinks.filter((s) => s !== sink);
    };
  }

  /** Receives one action type. */
  on(type: ActionType, sink: ActionSink): () => void {
    const list = this.listeners.get(type) ?? [];
    list.push(sink);
    this.listeners.set(type, list);
    return () => {
      this.listeners.set(
        type,
        (this.listeners.get(type) ?? []).filter((s) => s !== sink),
      );
    };
  }

  emit(action: Action): void {
    for (const sink of this.sinks) sink(action);
    for (const sink of this.listeners.get(action.type) ?? []) sink(action);
  }
}
