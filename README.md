# WWL Photo Gallery

This project is a static photo gallery that uses local files in `photos/` and metadata in `photos.json`.

## Deploy Flow

Run this command before deploy/publish:

```bash
npm run deploy
```

`npm run deploy` now runs the full content sync pipeline:

1. `npm run preflight`
1. `npm run sync-dates`
2. `npm run sync-metadata:missing`

If you want to skip AI metadata generation, use:

```bash
npm run deploy:no-ai
```

### What Each Step Does

1. `preflight`
- Verifies that `GEMINI_API_KEY` is set before AI-enabled deploy commands

1. `sync-dates`
- Scans `photos/`
- Updates `photos.json` with any new files
- Refreshes `date` and `dateTaken` fields from EXIF when available
- Regenerates `rss.xml`

2. `sync-metadata:missing`
- Calls Google Gemini Vision for images that are missing `title` and/or `description`
- Writes generated text back to `photos.json`

## Gemini Setup

Set your API key in your shell before running metadata generation or deploy:

```bash
export GEMINI_API_KEY="your_api_key_here"
```

Without `GEMINI_API_KEY`, `sync-metadata*` commands will fail.

## Useful Commands

```bash
# Start local site
npm run start

# Verify Gemini env var before deploy
npm run preflight

# Deploy flow without AI metadata generation
npm run deploy:no-ai

# Regenerate only missing titles/descriptions
npm run sync-metadata:missing

# Regenerate titles/descriptions for all photos
npm run sync-metadata

# Test metadata generation without writing file changes
node scripts/generate-photo-metadata.js --dry-run --limit=2
```

## Suggested Routine

1. Add new files to `photos/`
2. Run `npm run deploy`
3. Review `photos.json`
4. Commit and push
