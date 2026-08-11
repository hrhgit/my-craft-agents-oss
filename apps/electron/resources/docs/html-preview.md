# HTML Preview Guide

This guide covers how to render rich HTML content inline using `html-preview` code blocks, and how to prepare HTML files from various sources.

## Overview

The `html-preview` block renders HTML files in sandboxed iframes — perfect for emails, newsletters, HTML reports, and any content where markdown conversion would lose formatting.

| Format | Best For | Rendering |
|--------|----------|-----------|
| **Markdown** | Text-heavy content, code, lists | Native markdown rendering |
| **`html-preview` block** | Emails, newsletters, styled reports, rich HTML | Sandboxed iframe with full CSS |

**Key principle:** HTML content is always **file-backed** (referenced via `src`) to avoid inlining large HTML payloads as tokens. A typical email HTML body is 50-150KB — never inline this directly.

## When to Use

Use `html-preview` when:
- **Email HTML bodies** — Gmail, Outlook, or any email API returns HTML content
- **Newsletters** — Substack, Mailchimp, etc. have complex CSS layouts that markdown can't replicate
- **HTML reports** — API responses containing pre-formatted HTML (analytics dashboards, generated reports)
- **Rich documents** — Any content with complex CSS, table layouts, background images, or custom fonts
- **Web content** — HTML snapshots or previews where layout fidelity matters

Do NOT use `html-preview` when:
- Content is simple text — just output it as markdown
- Content is structured data — use `datatable` or `spreadsheet` instead
- Content is a code snippet — use regular code blocks with syntax highlighting
- The HTML is tiny (< 1KB) — summarize it in markdown instead

## Basic Usage

### Single Item

````
```html-preview
{
  "src": "/absolute/path/to/file.html",
  "title": "My HTML Content"
}
```
````

### Multiple Items (Tabs)

When you have multiple related HTML files (e.g., an email thread, multiple reports), use the `items` array. A tab bar appears below the header for switching between items.

````
```html-preview
{
  "title": "Email Thread",
  "items": [
    { "src": "/path/to/original.html", "label": "Original" },
    { "src": "/path/to/reply.html", "label": "Reply" },
    { "src": "/path/to/forward.html", "label": "Forward" }
  ]
}
```
````

Content loads lazily on tab switch and is cached once loaded.

### Config Fields

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `src` | Yes* | string | Absolute path to the HTML file on disk (single item mode) |
| `title` | No | string | Display title shown in the header bar (defaults to "HTML Preview") |
| `items` | Yes* | array | Array of items with `src` and optional `label` (multi-item mode) |
| `items[].src` | Yes | string | Absolute path to the HTML file |
| `items[].label` | No | string | Tab label (defaults to "Item 1", "Item 2", etc.) |

*Either `src` (single) or `items` (multiple) is required. If both are present, `items` takes precedence.

**Important:** The `src` path must be an **absolute path** — use the path of the file you wrote with the Write tool, or construct one using the session data folder path.

## Preparing HTML Content

### Writing the HTML File

Write the HTML file with the **Write tool** (to the session data folder). When the HTML is embedded in a larger response (e.g. a base64 email body or a JSON API payload), run a small script via the shell to decode/extract it, then write the result to the file.

**Key difference from datatable usage:** For `html-preview`, the output file is `.html` (not `.json`). The file contains raw HTML content, not JSON.

**Path conventions:**
- **Input files** are relative to the session directory. Common locations:
  - `long_responses/tool_result_abc.txt` — saved tool results (Gmail API responses, etc.)
  - `data/previous_output.html` — output from a prior run
- **Output file** goes in the session `data/` directory (e.g., `"email.html"`)

### Using Write Tool

For smaller HTML content (generated reports, simple HTML), you can use the `Write` tool directly to write an `.html` file to the session data folder, then reference it.

## Common Patterns & Recipes

### Gmail Email Rendering

Gmail API returns email bodies as base64url-encoded strings. The HTML body is typically in `payload.parts[1].body.data` for multipart emails.

**Robust pattern (handles all MIME structures):**

```python
import base64, json, sys

with open(sys.argv[1]) as f:
    msg = json.load(f)

# Recursively find text/html part in MIME structure
def find_html_part(payload):
    if payload.get('mimeType') == 'text/html':
        return payload.get('body', {}).get('data')
    for part in payload.get('parts', []):
        result = find_html_part(part)
        if result:
            return result
    return None

html_b64 = find_html_part(msg['payload'])
if not html_b64:
    # Fallback: body itself may be HTML (non-multipart emails)
    html_b64 = msg['payload'].get('body', {}).get('data', '')

# Gmail uses URL-safe base64
html = base64.urlsafe_b64decode(html_b64).decode('utf-8')

with open(sys.argv[-1], 'w') as f:
    f.write(html)
```

Run this script via the shell (input path = `long_responses/gmail_message.txt`, output = `email.html` in the session data folder), then write the result with the Write tool:
```
python3 script.py long_responses/gmail_message.txt data/email.html
```

**Simple shortcut (when you know the structure):**

```python
import base64, json, sys
data = json.load(open(sys.argv[1]))
html = base64.urlsafe_b64decode(data['payload']['parts'][1]['body']['data']).decode('utf-8')
open(sys.argv[-1], 'w').write(html)
```

### Microsoft Outlook Email

Outlook / Microsoft Graph API returns email bodies differently:

```python
import json, sys

with open(sys.argv[1]) as f:
    msg = json.load(f)

# Microsoft Graph returns HTML in body.content
html = msg.get('body', {}).get('content', '')

with open(sys.argv[-1], 'w') as f:
    f.write(html)
```

### HTML from API Responses

Many APIs return HTML content in a JSON field:

```python
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

# Adapt field name to your API
html = data.get('html_content', data.get('body_html', data.get('html', '')))

with open(sys.argv[-1], 'w') as f:
    f.write(html)
```

### Generated HTML Report

Build an HTML report from structured data:

```python
import json, sys

with open(sys.argv[1]) as f:
    data = json.load(f)

items = data.get('items', data.get('data', []))

rows_html = ''.join(
    f'<tr><td>{item["name"]}</td><td>${item["amount"]:,.2f}</td></tr>'
    for item in items
)

html = f"""<!DOCTYPE html>
<html>
<head>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif; padding: 24px; }}
  table {{ border-collapse: collapse; width: 100%; }}
  th, td {{ padding: 8px 12px; border-bottom: 1px solid #eee; text-align: left; }}
  th {{ font-weight: 600; color: #666; }}
</style>
</head>
<body>
<h2>Report</h2>
<table>
<thead><tr><th>Name</th><th>Amount</th></tr></thead>
<tbody>{rows_html}</tbody>
</table>
</body>
</html>"""

with open(sys.argv[-1], 'w') as f:
    f.write(html)
```

### Node.js Alternative

```javascript
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));

// Extract HTML from Gmail email
const html = Buffer.from(data.payload.parts[1].body.data, 'base64url').toString('utf-8');

fs.writeFileSync(process.argv.at(-1), html);
```

## Complete Workflow Example

User asks: "Show me that newsletter from Scott Belsky"

**Step 1:** Search Gmail for the email:
```
GET gmail/v1/users/me/messages?q=from:scott belsky subject:implications
```

**Step 2:** Fetch the full message:
```
GET gmail/v1/users/me/messages/{id}?format=full
```

**Step 3:** Decode the HTML body with a script via the shell (recursive `find_html_part()` pattern from the Gmail recipe above):
```
python3 decode_gmail.py long_responses/gmail_result.txt data/newsletter.html
```

**Step 4:** Output the html-preview block with the absolute path of the written file:
````
```html-preview
{
  "src": "/absolute/path/to/newsletter.html",
  "title": "Implications #40 — Exponential Code, Network Effects In AI"
}
```
````

## Rendering Behavior

### Inline Preview
- Fixed **max-height of 400px** with bottom fade gradient indicating more content below
- **Expand button** (top-right corner, visible on hover) opens fullscreen view
- **Header bar** shows Globe icon and title

### Fullscreen Overlay
- Click expand button for **full-height rendering** with scrollable content
- **Copy HTML** button copies the raw HTML source to clipboard
- **"HTML" badge** in header identifies the content type

### Visual Details
- **White background** — iframes render with white background (standard for HTML emails/documents)
- **External images** — load from their original URLs (`https://` supported by CSP)
- **CSS styling** — all inline and embedded styles work (no external stylesheet restrictions)
- **Responsive layouts** — if the HTML has responsive CSS, it adapts to the iframe width

## Email-Specific Tips

### Finding the HTML Part

Email MIME structures vary. Common patterns:

| Structure | HTML Location |
|-----------|--------------|
| `multipart/alternative` | `payload.parts[1].body.data` (index 1 is usually HTML) |
| `multipart/mixed` → `multipart/alternative` | `payload.parts[0].parts[1].body.data` |
| Single-part HTML | `payload.body.data` (no parts array) |
| Text-only email | No HTML part — use markdown instead |

**Always use the recursive `find_html_part()` pattern** from the Gmail recipe above — it handles all structures reliably.

### Gmail Base64 Encoding

Gmail uses **URL-safe base64** (RFC 4648 §5):
- Uses `-` and `_` instead of `+` and `/`
- No padding (`=`)
- Python: `base64.urlsafe_b64decode()` handles this
- Node: `Buffer.from(data, 'base64url')`

**Do NOT use** standard `base64.b64decode()` — it will fail on URL-safe encoded content.

### Large Emails

Some newsletter HTML bodies are 100KB+. This is fine:
- Write the file to disk with the Write tool (no token cost)
- The iframe loads the file directly
- The 400px inline preview shows just the top portion

## Security

HTML renders in a **sandboxed iframe** with these restrictions:

| Feature | Status | Details |
|---------|--------|---------|
| JavaScript execution | **Blocked** | `sandbox` attr without `allow-scripts` |
| Form submission | **Blocked** | No `allow-forms` |
| Link navigation | **Blocked** | Sandbox prevents all navigation |
| Popups / new windows | **Blocked** | No `allow-popups` |
| CSS styling | **Allowed** | Inline, embedded, and `<style>` tags work |
| Images (`https://`) | **Allowed** | External images load normally |
| Images (`data:`) | **Allowed** | Base64-encoded images work |
| Embedded fonts | **Allowed** | Google Fonts and other CDN fonts load |

**No HTML sanitization is needed** — the `sandbox` attribute provides complete process-level isolation. Malicious scripts, forms, and navigation are all blocked at the browser engine level.

## Best Practices

### Decision Tree

```
Is the content rich HTML with important styling/layout?
  → YES: Use html-preview
  → NO: Convert to markdown

Is the HTML content large (> 1KB)?
  → YES: Write the file and reference via src
  → NO: Consider just summarizing in markdown

Does the user explicitly want to SEE the email/HTML?
  → YES: Use html-preview (visual fidelity matters)
  → NO: Extract text content and present as markdown
```

### Naming Conventions

- Output files: descriptive, kebab-case — `newsletter-jan-2026.html`, `quarterly-report.html`
- Match the context — if user asked about a specific email, name it after the subject

### Script Tips

- Prefer Python for email decoding — `base64` and `json` are stdlib, no dependencies needed
- Always use `urlsafe_b64decode` for Gmail (never `b64decode`)
- Use the recursive `find_html_part()` pattern — it handles all email structures
- Keep scripts concise — complex logic is harder to debug in the 30s timeout

## Troubleshooting

### "Loading..." shown indefinitely
- The `"src"` path must be an **absolute path** — use the path of the file you wrote
- Do not construct relative paths or guess the data folder location
- Verify the file actually exists at that path

### Blank/white iframe
- The HTML file may be empty — check the decoding script output for errors
- The base64 decoding may have failed silently — verify the script handles the email structure correctly
- Check if the email has an HTML part at all (some are text-only)

### Images not loading
- Images with `http://` URLs may be blocked (CSP requires `https://`)
- Some email images use tracking pixels that may have expired
- `cid:` (Content-ID) inline images are not supported — they require the email's MIME attachments

### Garbled text / encoding issues
- Always decode with `utf-8`: `.decode('utf-8')`
- Some older emails use different encodings — check the `Content-Type` header for `charset`
- If charset is not UTF-8, decode accordingly: `.decode(charset)`

### HTML shows as raw code (not rendered)
- Verify the code block language is `html-preview` (not `html` or `htm`)
- Check that the JSON config is valid: must have `"src"` field
- Ensure the file content is actual HTML (not JSON containing HTML)

### Script errors
- `KeyError` on `payload.parts` — email may be single-part (no `parts` array). Use the recursive `find_html_part()` pattern
- `binascii.Error: Invalid base64` — email may use standard base64, not URL-safe. Try `base64.b64decode()` as fallback
- `UnicodeDecodeError` — check the email's charset encoding (see encoding issues above)
