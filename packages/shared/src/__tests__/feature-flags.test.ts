import { describe, it, expect, afterEach } from 'bun:test';
import { isDevRuntime, isDeveloperFeedbackEnabled, isMortiseCliEnabled, isEmbeddedServerEnabled } from '../feature-flags.ts';

const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  MORTISE_DEBUG: process.env.MORTISE_DEBUG,
  MORTISE_FEATURE_DEVELOPER_FEEDBACK: process.env.MORTISE_FEATURE_DEVELOPER_FEEDBACK,
  MORTISE_FEATURE_CLI: process.env.MORTISE_FEATURE_CLI,
  MORTISE_FEATURE_EMBEDDED_SERVER: process.env.MORTISE_FEATURE_EMBEDDED_SERVER,
};

afterEach(() => {
  if (ORIGINAL_ENV.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_ENV.NODE_ENV;

  if (ORIGINAL_ENV.MORTISE_DEBUG === undefined) delete process.env.MORTISE_DEBUG;
  else process.env.MORTISE_DEBUG = ORIGINAL_ENV.MORTISE_DEBUG;

  if (ORIGINAL_ENV.MORTISE_FEATURE_DEVELOPER_FEEDBACK === undefined) delete process.env.MORTISE_FEATURE_DEVELOPER_FEEDBACK;
  else process.env.MORTISE_FEATURE_DEVELOPER_FEEDBACK = ORIGINAL_ENV.MORTISE_FEATURE_DEVELOPER_FEEDBACK;

  if (ORIGINAL_ENV.MORTISE_FEATURE_CLI === undefined) delete process.env.MORTISE_FEATURE_CLI;
  else process.env.MORTISE_FEATURE_CLI = ORIGINAL_ENV.MORTISE_FEATURE_CLI;

  if (ORIGINAL_ENV.MORTISE_FEATURE_EMBEDDED_SERVER === undefined) delete process.env.MORTISE_FEATURE_EMBEDDED_SERVER;
  else process.env.MORTISE_FEATURE_EMBEDDED_SERVER = ORIGINAL_ENV.MORTISE_FEATURE_EMBEDDED_SERVER;
});

describe('feature-flags runtime helpers', () => {
  it('isDevRuntime returns true for explicit dev NODE_ENV', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.MORTISE_DEBUG;

    expect(isDevRuntime()).toBe(true);
  });

  it('isDevRuntime returns true for MORTISE_DEBUG override', () => {
    process.env.NODE_ENV = 'production';
    process.env.MORTISE_DEBUG = '1';

    expect(isDevRuntime()).toBe(true);
  });

  it('isDeveloperFeedbackEnabled honors explicit override false', () => {
    process.env.NODE_ENV = 'development';
    process.env.MORTISE_FEATURE_DEVELOPER_FEEDBACK = '0';

    expect(isDeveloperFeedbackEnabled()).toBe(false);
  });

  it('isDeveloperFeedbackEnabled honors explicit override true', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.MORTISE_DEBUG;
    process.env.MORTISE_FEATURE_DEVELOPER_FEEDBACK = '1';

    expect(isDeveloperFeedbackEnabled()).toBe(true);
  });

  it('isDeveloperFeedbackEnabled falls back to dev runtime when no override', () => {
    process.env.NODE_ENV = 'production';
    process.env.MORTISE_DEBUG = '1';
    delete process.env.MORTISE_FEATURE_DEVELOPER_FEEDBACK;

    expect(isDeveloperFeedbackEnabled()).toBe(true);
  });

  it('isMortiseCliEnabled defaults to false when no override is set', () => {
    delete process.env.MORTISE_FEATURE_CLI;

    expect(isMortiseCliEnabled()).toBe(false);
  });

  it('isMortiseCliEnabled honors explicit override true', () => {
    process.env.MORTISE_FEATURE_CLI = '1';

    expect(isMortiseCliEnabled()).toBe(true);
  });

  it('isMortiseCliEnabled honors explicit override false', () => {
    process.env.MORTISE_FEATURE_CLI = '0';

    expect(isMortiseCliEnabled()).toBe(false);
  });

  it('isEmbeddedServerEnabled defaults to false when no override is set', () => {
    delete process.env.MORTISE_FEATURE_EMBEDDED_SERVER;

    expect(isEmbeddedServerEnabled()).toBe(false);
  });

  it('isEmbeddedServerEnabled honors explicit override true', () => {
    process.env.MORTISE_FEATURE_EMBEDDED_SERVER = '1';

    expect(isEmbeddedServerEnabled()).toBe(true);
  });

  it('isEmbeddedServerEnabled honors explicit override false', () => {
    process.env.MORTISE_FEATURE_EMBEDDED_SERVER = '0';

    expect(isEmbeddedServerEnabled()).toBe(false);
  });
});
