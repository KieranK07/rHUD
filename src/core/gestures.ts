/**
 * Pose -> intent.
 *
 * Every gesture uses separate engage and release thresholds. A single
 * threshold sits right where tracking noise lives, so a hand held near it
 * machine-guns start/end events; the gap between the two makes that
 * impossible. Dwell and cooldown then filter out anything that fires during a
 * fast transition between deliberate poses.
 */

import { config } from '../config.ts';
import type { Action, ActionBus, ActionType } from '../action/ActionBus.ts';
import type { Chirality } from '../input/HandSource.ts';
import type { HandState } from './HandState.ts';

export type GestureName = 'pinch' | 'fist' | 'open' | 'point';

interface GestureSlot {
  active: boolean;
  /** When the raw condition first became true; -1 while unmet. */
  candidateSince: number;
  lastFired: number;
}

export class GestureRecognizer {
  private slots = new Map<string, GestureSlot>();

  constructor(private bus: ActionBus) {}

  update(hands: HandState[], now: number): void {
    for (const hand of hands) {
      if (!hand.present) {
        // Release anything still held, so a hand leaving frame mid-pinch
        // doesn't strand a latched gesture.
        for (const name of ['pinch', 'fist', 'open', 'point'] as GestureName[]) {
          const slot = this.slot(hand.chirality, name);
          if (slot.active) {
            slot.active = false;
            slot.candidateSince = -1;
            this.fire(`${name}.end` as ActionType, hand.chirality, now);
          }
        }
        continue;
      }

      const g = config.gestures;
      const meanCurl = hand.curl.reduce((a, b) => a + b, 0) / hand.curl.length;

      this.evaluate(hand, 'pinch', now, hand.pinch < g.pinchEngage, hand.pinch > g.pinchRelease, {
        strength: 1 - Math.min(1, hand.pinch / g.pinchRelease),
      });

      this.evaluate(hand, 'fist', now, meanCurl > g.fistEngage, meanCurl < g.fistRelease, {
        curl: meanCurl,
      });

      this.evaluate(hand, 'open', now, meanCurl < g.openEngage, meanCurl > g.openRelease, {
        curl: meanCurl,
      });

      // Index extended while the other three are folded. The thumb is
      // excluded — it sits at too many angles to be a reliable signal here.
      const indexOut = (hand.curl[1] ?? 0) < 0.25;
      const othersIn =
        (hand.curl[2] ?? 0) > 0.6 && (hand.curl[3] ?? 0) > 0.6 && (hand.curl[4] ?? 0) > 0.6;
      this.evaluate(
        hand,
        'point',
        now,
        indexOut && othersIn,
        !indexOut || (hand.curl[2] ?? 0) < 0.45,
        {},
      );
    }
  }

  private evaluate(
    hand: HandState,
    name: GestureName,
    now: number,
    engageCondition: boolean,
    releaseCondition: boolean,
    data: Record<string, number>,
  ): void {
    const slot = this.slot(hand.chirality, name);
    const g = config.gestures;

    if (!slot.active) {
      if (!engageCondition) {
        slot.candidateSince = -1;
        return;
      }
      if (slot.candidateSince < 0) slot.candidateSince = now;

      const held = now - slot.candidateSince >= g.dwellMs;
      const cooled = now - slot.lastFired >= g.cooldownMs;
      if (held && cooled) {
        slot.active = true;
        slot.lastFired = now;
        this.fire(`${name}.start` as ActionType, hand.chirality, now, data);
      }
    } else if (releaseCondition) {
      slot.active = false;
      slot.candidateSince = -1;
      this.fire(`${name}.end` as ActionType, hand.chirality, now, data);
    }
  }

  private slot(chirality: Chirality, name: GestureName): GestureSlot {
    const key = `${chirality}:${name}`;
    let slot = this.slots.get(key);
    if (!slot) {
      slot = { active: false, candidateSince: -1, lastFired: -Infinity };
      this.slots.set(key, slot);
    }
    return slot;
  }

  private fire(
    type: ActionType,
    hand: Chirality,
    t: number,
    data?: Record<string, number>,
  ): void {
    const action: Action = { type, hand, t, ...(data && Object.keys(data).length ? { data } : {}) };
    this.bus.emit(action);
  }

  /** Is this gesture currently held? Used by the reticle for visual state. */
  isActive(chirality: Chirality, name: GestureName): boolean {
    return this.slot(chirality, name).active;
  }
}
