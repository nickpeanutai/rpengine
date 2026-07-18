import { describe, expect, it } from 'vitest';
import { FireRedVadStateMachine } from './fire-red-vad-state';

describe('FireRedVAD capture state', () => {
  it('starts after 200 ms and ends after 500 ms of silence', () => {
    const machine = new FireRedVadStateMachine();
    const states: string[] = [];
    let seconds = 0;
    for (let index = 0; index < 30; index += 1) { seconds += 0.01; const update = machine.process(0.9, seconds); if (update) states.push(update.state); }
    for (let index = 0; index < 55; index += 1) { seconds += 0.01; const update = machine.process(0.1, seconds); if (update) states.push(update.state); }
    expect(states).toEqual(['speech_started', 'speech_ended']);
  });

  it('does not submit a speech burst shorter than 250 ms', () => {
    const machine = new FireRedVadStateMachine();
    const states: string[] = [];
    let seconds = 0;
    for (let index = 0; index < 20; index += 1) { seconds += 0.01; const update = machine.process(0.9, seconds); if (update) states.push(update.state); }
    for (let index = 0; index < 55; index += 1) { seconds += 0.01; const update = machine.process(0.1, seconds); if (update) states.push(update.state); }
    expect(states).toEqual(['speech_started', 'listening']);
  });

  it('does not end during a short pause', () => {
    const machine = new FireRedVadStateMachine();
    const states: string[] = [];
    let seconds = 0;
    for (const [probability, frames] of [[0.9, 35], [0.1, 30], [0.9, 20]] as const) {
      for (let index = 0; index < frames; index += 1) { seconds += 0.01; const update = machine.process(probability, seconds); if (update) states.push(update.state); }
    }
    expect(states).toEqual(['speech_started']);
  });
});
