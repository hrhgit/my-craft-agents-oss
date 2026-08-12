/**
 * OAuth callback page HTML generation.
 * This module is browser-safe (no Node.js dependencies) so it can be used
 * in both the callback server and the playground preview.
 */

import { MORTISE_LOGO_HTML } from '../branding.ts';

export type AppType = 'terminal' | 'electron';

/** Locales the generated callback page can render (kept dependency-free / browser-safe). */
export type CallbackPageLocale = 'en' | 'zh-Hans';

/**
 * Copy used by the callback page. Values mirror the flat dictionary keys in
 * `oauth.callback.*` (output/i18n/overlay-wizard.{en,zh}.json) so the embedded
 * table stays in sync with the i18n dictionaries.
 */
export interface CallbackPageCopy {
  /** oauth.callback.title.success */
  titleSuccess: string;
  /** oauth.callback.title.complete */
  titleComplete: string;
  /** oauth.callback.title.failed */
  titleFailed: string;
  /** oauth.callback.title.security */
  titleSecurity: string;
  /** oauth.callback.title.error */
  titleError: string;
  /** oauth.callback.status.success */
  statusSuccess: string;
  /** oauth.callback.status.failed */
  statusFailed: string;
  /** oauth.callback.status.failedDetail ({{detail}} placeholder) */
  statusFailedDetail: string;
  /** oauth.callback.hint.success */
  hintSuccess: string;
  /** oauth.callback.hint.failed */
  hintFailed: string;
  /** oauth.callback.error.stateMismatch */
  errorStateMismatch: string;
  /** oauth.callback.error.noCode */
  errorNoCode: string;
  /** oauth.callback.error.internal */
  errorInternal: string;
}

const CALLBACK_PAGE_COPY: Record<CallbackPageLocale, CallbackPageCopy> = {
  en: {
    titleSuccess: 'Authorization Successful',
    titleComplete: 'Authorization Complete',
    titleFailed: 'Authorization Failed',
    titleSecurity: 'Security Error',
    titleError: 'Error',
    statusSuccess: 'Authorization successful',
    statusFailed: 'Authorization failed',
    statusFailedDetail: 'Authorization failed: {{detail}}',
    hintSuccess: 'You can now return to the application.',
    hintFailed: 'Please close this window and try again.',
    errorStateMismatch: 'State mismatch - possible CSRF attack.',
    errorNoCode: 'No authorization code received.',
    errorInternal: 'Internal Server Error',
  },
  'zh-Hans': {
    titleSuccess: '授权成功',
    titleComplete: '授权完成',
    titleFailed: '授权失败',
    titleSecurity: '安全错误',
    titleError: '错误',
    statusSuccess: '授权成功',
    statusFailed: '授权失败',
    statusFailedDetail: '授权失败：{{detail}}',
    hintSuccess: '现在可以返回应用了。',
    hintFailed: '请关闭此窗口后重试。',
    errorStateMismatch: '状态不匹配，可能存在 CSRF 攻击。',
    errorNoCode: '未收到授权码。',
    errorInternal: '服务器内部错误',
  },
};

/** Map any BCP-47 language code to a supported callback page locale (defaults to 'en'). */
export function resolveCallbackPageLocale(lang?: string | null): CallbackPageLocale {
  if (lang && lang.toLowerCase().startsWith('zh')) return 'zh-Hans';
  return 'en';
}

/** Get the callback page copy table for a locale (falls back to 'en'). */
export function getCallbackPageCopy(locale: CallbackPageLocale = 'en'): CallbackPageCopy {
  return CALLBACK_PAGE_COPY[locale] ?? CALLBACK_PAGE_COPY.en;
}

/**
 * Localize app-authored copy passed in by callers (titles, known error details).
 *
 * Callers pass the English defaults (kept as the API contract); when they match
 * a known entry they are mapped to the requested locale. Provider-supplied or
 * dynamic details (OAuth `error` params, thrown Error messages) do not match and
 * pass through unchanged.
 */
function localizeKnownCopy(text: string, copy: CallbackPageCopy): string {
  const known: Array<[string, string]> = [
    ['Authorization Successful', copy.titleSuccess],
    ['Authorization Complete', copy.titleComplete],
    ['Authorization Failed', copy.titleFailed],
    ['Security Error', copy.titleSecurity],
    ['Error', copy.titleError],
    ['State mismatch - possible CSRF attack.', copy.errorStateMismatch],
    ['No authorization code received.', copy.errorNoCode],
    ['Internal Server Error', copy.errorInternal],
  ];
  for (const [en, localized] of known) {
    if (text === en) return localized;
  }
  return text;
}

/**
 * Generate a minimal, clean callback page matching the app's design system.
 * Logo at top, status message in a card below.
 */
export function generateCallbackPage(options: {
  title: string;
  isSuccess: boolean;
  errorDetail?: string;
  appType?: AppType;
  deeplinkUrl?: string;
  locale?: CallbackPageLocale;
}): string {
  const { title, isSuccess, errorDetail, deeplinkUrl, locale = 'en' } = options;
  const copy = getCallbackPageCopy(locale);

  // Localize app-authored copy; dynamic details pass through as-is.
  const pageTitle = localizeKnownCopy(title, copy);
  const localizedErrorDetail = errorDetail ? localizeKnownCopy(errorDetail, copy) : undefined;

  // Status message based on success/error
  const statusMessage = isSuccess
    ? copy.statusSuccess
    : localizedErrorDetail
      ? copy.statusFailedDetail.replace('{{detail}}', localizedErrorDetail)
      : copy.statusFailed;

  // Generate deeplink redirect and auto-close for success
  const autoCloseScript = isSuccess
    ? `
    setTimeout(() => {
      ${deeplinkUrl ? `window.location.href = '${deeplinkUrl}';` : ''}
      window.close();
    }, 1500);`
    : '';


  return `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mortise - ${pageTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      width: 100vw;
      height: 100vh;
      /* bg-foreground-2: 2% foreground mixed with background */
      background-color: #f7f7f7;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }

    .logo {
      /* Purple accent: oklch(0.62 0.13 293) */
      color: #8b5fb3;
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, monospace;
      font-size: 6px;
      line-height: 1;
      white-space: pre;
      /* Negative letter-spacing to close gaps between block characters */
      letter-spacing: -0.05em;
      /* 48px above the card */
      margin-bottom: 48px;
    }

    .content {
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .card {
      max-width: 480px;
      border-radius: 8px;
      padding: 16px 24px;
      text-align: center;
      /* Tinted background and shadow based on state */
      ${isSuccess
        ? `/* Success state - green tinted */
      background-color: rgba(34, 120, 60, 0.03);
      box-shadow:
        rgba(34, 120, 60, 0.12) 0px 0px 0px 1px,
        rgba(34, 120, 60, 0.08) 0px 1px 1px -0.5px,
        rgba(34, 120, 60, 0.06) 0px 3px 3px -1.5px,
        rgba(34, 120, 60, 0.04) 0px 6px 6px -3px;`
        : `/* Error state - red tinted */
      background-color: rgba(180, 60, 50, 0.03);
      box-shadow:
        rgba(180, 60, 50, 0.12) 0px 0px 0px 1px,
        rgba(180, 60, 50, 0.08) 0px 1px 1px -0.5px,
        rgba(180, 60, 50, 0.06) 0px 3px 3px -1.5px,
        rgba(180, 60, 50, 0.04) 0px 6px 6px -3px;`
      }
    }

    .status {
      font-size: 14px;
      font-weight: 400;
      /* Text color mixed 50% with foreground for readability */
      color: ${isSuccess ? '#2d6b47' : '#a14040'};
    }

    .hint {
      margin-top: 24px;
      font-size: 13px;
      color: rgba(0, 0, 0, 0.4);
    }

    .return-link {
      display: inline-block;
      margin-top: 16px;
      padding: 10px 20px;
      font-size: 14px;
      font-weight: 500;
      color: #fff;
      background-color: #8b5fb3;
      border-radius: 6px;
      text-decoration: none;
      transition: background-color 0.15s ease;
    }

    .return-link:hover {
      background-color: #7a4fa3;
    }

    @media (prefers-color-scheme: dark) {
      body {
        background-color: #1a1a1a;
      }
      .logo {
        /* Brighter purple in dark mode: oklch(0.68 0.13 293) */
        color: #a882c9;
      }
      .card {
        ${isSuccess
          ? `/* Success state dark - green tinted */
        background-color: rgba(50, 140, 80, 0.03);
        box-shadow:
          rgba(50, 140, 80, 0.12) 0px 0px 0px 1px,
          rgba(50, 140, 80, 0.08) 0px 1px 1px -0.5px,
          rgba(50, 140, 80, 0.06) 0px 3px 3px -1.5px,
          rgba(50, 140, 80, 0.04) 0px 6px 6px -3px;`
          : `/* Error state dark - red tinted */
        background-color: rgba(200, 80, 70, 0.03);
        box-shadow:
          rgba(200, 80, 70, 0.12) 0px 0px 0px 1px,
          rgba(200, 80, 70, 0.08) 0px 1px 1px -0.5px,
          rgba(200, 80, 70, 0.06) 0px 3px 3px -1.5px,
          rgba(200, 80, 70, 0.04) 0px 6px 6px -3px;`
        }
      }
      .status {
        /* Brighter text colors in dark mode */
        color: ${isSuccess ? '#6bc489' : '#e88080'};
      }
      .hint {
        color: rgba(255, 255, 255, 0.4);
      }
    }
  </style>
</head>
<body>
  <div class="content">
    <pre class="logo">${MORTISE_LOGO_HTML}</pre>
    <div class="card">
      <div class="status">${statusMessage}</div>
    </div>
    <div class="hint">${isSuccess ? copy.hintSuccess : copy.hintFailed}</div>
    ${deeplinkUrl ? `<a href="${deeplinkUrl}" class="return-link">Mortise</a>` : ''}
  </div>
  <script>${autoCloseScript}</script>
</body>
</html>`;
}
