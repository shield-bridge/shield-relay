import { describe, it, expect } from 'vitest';
import { lowGasAction } from '../src/observability/balanceMonitor.js';

const HOUR = 60 * 60 * 1000;
const REALERT = 24 * HOUR;

describe('lowGasAction (edge-triggered low-gas watchdog)', () => {
  it('alerts on the first crossing below the threshold', () => {
    expect(lowGasAction(true, null, 1_000, REALERT)).toBe('alert');
  });

  it('stays silent while still low and within the re-alert window', () => {
    const lastAlertAt = 1_000;
    expect(lowGasAction(true, lastAlertAt, lastAlertAt + HOUR, REALERT)).toBe('none');
    expect(lowGasAction(true, lastAlertAt, lastAlertAt + REALERT - 1, REALERT)).toBe('none');
  });

  it('re-alerts once the re-alert window has elapsed (still low)', () => {
    const lastAlertAt = 1_000;
    expect(lowGasAction(true, lastAlertAt, lastAlertAt + REALERT, REALERT)).toBe('alert');
    expect(lowGasAction(true, lastAlertAt, lastAlertAt + REALERT + HOUR, REALERT)).toBe('alert');
  });

  it('reports recovery when a previously-low worker is back above', () => {
    expect(lowGasAction(false, 1_000, 2_000, REALERT)).toBe('recovered');
  });

  it('does nothing when a healthy worker stays healthy', () => {
    expect(lowGasAction(false, null, 5_000, REALERT)).toBe('none');
  });

  it('does not spam: many consecutive low checks yield exactly one alert until the window passes', () => {
    let lastAlertAt: number | null = null;
    let alerts = 0;
    // simulate 24 hourly checks, all low, with a 24h re-alert window
    for (let h = 0; h <= 23; h++) {
      const now = h * HOUR;
      const action = lowGasAction(true, lastAlertAt, now, REALERT);
      if (action === 'alert') {
        alerts++;
        lastAlertAt = now;
      }
    }
    expect(alerts).toBe(1); // only the initial crossing in the first 24h, not one per check
  });
});
