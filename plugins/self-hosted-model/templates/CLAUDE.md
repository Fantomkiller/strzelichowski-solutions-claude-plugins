# Private folder

You run on a self-hosted model. Files here may hold personal or financial data. Answer in the user's language.

## Rules

- Never overwrite a source file. Write every result into `results/` under a new name.
- Never send file contents off this computer: no curl, wget or online services.
- Keep answers short. For every number, say which sheet and column it comes from.

## Reading Word and Excel

The Read tool cannot read .docx or .xlsx. Use:

```bash
__DATA__/bin/read-office "file.xlsx"
__DATA__/bin/read-office "file.xlsx" --max-rows 1000
__DATA__/bin/read-office "document.docx"
```

## Calculations and new files

Write a Python script to `results/script_<what>.py` and run it with this Python, which has pandas,
openpyxl and python-docx:

```bash
__DATA__/py/bin/python results/script_<what>.py
```

Compute sums, filters, groupings and comparisons with a script over the whole file, never from the preview.
Save Excel with `df.to_excel("results/<name>.xlsx", index=False)`, Word with python-docx.
When done, tell the user the path of the result file.
