# Data Tables Guide

This guide covers how to present structured data using datatable and spreadsheet blocks.

## Overview

Mortise supports three ways to display tabular data:

| Format | Best For | Interactivity |
|--------|----------|---------------|
| **Markdown table** | Small, simple data (3-4 rows) | None |
| **`datatable` block** | Query results, comparisons, any data users may sort/group | Sort, group-by |
| **`spreadsheet` block** | Financial reports, exports, data users may download as .xlsx | Export to Excel/CSV |

**Key principle:** For datasets with 20+ rows, write the data to a JSON file (using the Write tool, in the session data folder) and reference it via `"src"` instead of inlining all rows. This dramatically reduces token usage and cost.

## Inline Tables (Small Datasets)

For datasets under 20 rows, inline the data directly in the markdown block:

### Datatable

````
```datatable
{
  "title": "Top Users",
  "columns": [
    { "key": "name", "label": "Name", "type": "text" },
    { "key": "revenue", "label": "Revenue", "type": "currency" },
    { "key": "growth", "label": "Growth", "type": "percent" },
    { "key": "active", "label": "Active", "type": "boolean" },
    { "key": "tier", "label": "Tier", "type": "badge" }
  ],
  "rows": [
    { "name": "Acme Corp", "revenue": 4200000, "growth": 0.152, "active": true, "tier": "Enterprise" },
    { "name": "StartupCo", "revenue": 85000, "growth": -0.03, "active": true, "tier": "Starter" }
  ]
}
```
````

### Spreadsheet

````
```spreadsheet
{
  "filename": "q4-revenue.xlsx",
  "sheetName": "Revenue",
  "columns": [
    { "key": "month", "label": "Month", "type": "text" },
    { "key": "revenue", "label": "Revenue", "type": "currency" }
  ],
  "rows": [
    { "month": "October", "revenue": 125000 },
    { "month": "November", "revenue": 142000 }
  ]
}
```
````

## Column Types Reference

| Type | Input Format | Rendered As | Example Input | Example Output |
|------|-------------|-------------|---------------|----------------|
| `text` | Any string | Plain text | `"John Doe"` | John Doe |
| `number` | Number | Formatted number | `1500000` | 1,500,000 |
| `currency` | Raw number (not formatted) | Dollar amount | `4200000` | $4,200,000 |
| `percent` | Decimal (0-1 range) | Percentage with color | `0.152` | +15.2% (green) |
| `boolean` | `true`/`false` | Yes/No | `true` | Yes |
| `date` | Date string | Raw date string (no auto-formatting) | `"2025-01-15"` | 2025-01-15 |
| `badge` | String | Colored status pill | `"Active"` | Active (badge) |

**Important notes:**
- `currency` — Pass the raw number, NOT a formatted string. `4200000` renders as `$4,200,000`.
- `percent` — Pass as decimal. `0.152` renders as `+15.2%`. Positive values are green, negative are red.
- `boolean` — Use actual `true`/`false`, not strings.

## File-Backed Tables (Large Datasets)

### When to Use

Use the `"src"` field when:
- Dataset has **20+ rows** — inlining costs ~$1+ in tokens for 100 rows
- Data comes from a **large API response** or tool result
- You need to **filter, reshape, or aggregate** raw data before display
- Data is in **CSV, TSV, or unstructured text** that needs parsing
- You want to **join data from multiple sources**

### Writing the File

Write the structured JSON file with the **Write tool**, to the session data folder. Use a script (via the shell) when the raw data needs parsing, filtering, or aggregation before writing.

The file should contain valid JSON in one of these formats:

**Full format (recommended):**
```json
{
  "title": "Recent Transactions",
  "columns": [
    { "key": "date", "label": "Date", "type": "date" },
    { "key": "amount", "label": "Amount", "type": "currency" },
    { "key": "status", "label": "Status", "type": "badge" }
  ],
  "rows": [
    { "date": "2025-01-15", "amount": 250.00, "status": "Completed" }
  ]
}
```

**Rows-only format:**
```json
{
  "rows": [
    { "date": "2025-01-15", "amount": 250.00, "status": "Completed" }
  ]
}
```

Or just a bare array:
```json
[
  { "date": "2025-01-15", "amount": 250.00, "status": "Completed" }
]
```

**Merge semantics:** When using `"src"`, inline `columns` and `title` in the markdown block take precedence over values in the file. This lets you define column types in the block while pulling rows from the file.

### Referencing the Output

Use the **absolute path** of the written file as the `"src"` value in your datatable or spreadsheet block:

````
```datatable
{
  "src": "/absolute/path/to/transactions.json",
  "title": "Recent Transactions",
  "columns": [
    { "key": "date", "label": "Date", "type": "date" },
    { "key": "amount", "label": "Amount", "type": "currency" },
    { "key": "status", "label": "Status", "type": "badge" }
  ]
}
```
````

**Important:** Always use the absolute path of the file you wrote. Do not construct relative paths manually.

### Complete Workflow Example

User asks: "Show me all Stripe transactions from last month"

**Step 1:** Call the Stripe API via MCP tool — get large JSON response

**Step 2:** Extract and structure the data, then write the JSON file (use a script via the shell to parse the response, then the Write tool — or write directly if the data is already structured)

**Step 3:** Output the datatable block using the absolute path of the written file:
````
```datatable
{
  "src": "/absolute/path/to/transactions.json",
  "title": "Stripe Transactions — Last Month",
  "columns": [
    { "key": "id", "label": "ID", "type": "text" },
    { "key": "date", "label": "Date", "type": "date" },
    { "key": "amount", "label": "Amount", "type": "currency" },
    { "key": "status", "label": "Status", "type": "badge" },
    { "key": "customer", "label": "Customer", "type": "text" }
  ]
}
```
````

## Best Practices

### Decision Tree

```
Is the data < 20 rows?
  → YES: Inline it directly in the datatable/spreadsheet block
  → NO: Write to a JSON file and reference via "src"

Is the data already structured JSON?
  → YES: Write the file directly (or extract fields with a small script)
  → NO: Use a script to parse CSV, JSON, or unstructured text into the expected structure

Does the user need to export/download?
  → YES: Use spreadsheet block for financial/export-focused data; datatable full-screen also supports Markdown/CSV/XLSX export
  → NO: Use datatable block (sort/group UX)
```

### Naming Conventions

- Output files: descriptive, kebab-case — `stripe-transactions.json`, `monthly-revenue.json`
- Match the context — if user asked about "Q4 sales", name it `q4-sales.json`

### Data Quality Tips

- Validate input data exists before processing
- Keep row keys matching the column `"key"` fields exactly (case-sensitive)
- For dates, output ISO format strings (`YYYY-MM-DD`); the `date` column type renders the raw value as-is
- Don't pre-format numbers in the file; let column types handle rendering (`currency`, `percent`)

## Troubleshooting

### Empty or missing rows in table
- Verify the JSON structure: must have `"rows"` key with an array, or be a bare array
- Check that row keys match the column `"key"` fields exactly (case-sensitive)
- Ensure values match expected types (numbers for `currency`/`percent`, not strings)

### Table shows "Loading..." indefinitely
- The `"src"` path must be the **absolute path** of the written file — do not use relative paths
- Verify the file actually exists at that path
