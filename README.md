# WWL Photo Gallery

This project is a static photo gallery that uses local files in `photos/` and metadata in `photos.json`.

## Deploy Flow

Run this command before deploy/publish:

```bash
npm run deploy
```

`npm run deploy` runs the full content sync pipeline:

1. `npm run preflight`
2. `npm run sync-dates`
3. `npm run sync-metadata:missing`

If you want to skip AI metadata generation, use:

```bash
npm run deploy:no-ai
```

### What Each Step Does

1. `preflight`
   - Verifies that `GEMINI_API_KEY` is set before AI-enabled deploy commands

2. `sync-dates`
   - Scans `photos/`
   - Updates `photos.json` with any new files
   - Refreshes `date` and `dateTaken` fields from EXIF when available
   - Regenerates `rss.xml`

3. `sync-metadata:missing`
   - Calls the configured AI provider for images missing `title` and/or `description`
   - Also reads EXIF data (camera, lens, aperture, shutter, ISO, focal length) from each file
   - Writes everything back to `photos.json`

## API Keys

Both keys are stored in `.env` (gitignored). Create the file if it doesn't exist:

```
GEMINI_API_KEY=your_gemini_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
```

## AI Providers

Metadata generation supports two providers. Gemini is the default.

### Gemini (default)

Uses `gemini-2.5-flash`. Get a key at [aistudio.google.com](https://aistudio.google.com).

```bash
npm run sync-metadata:missing         # missing only
npm run sync-metadata                 # all photos
```

### Claude

Uses `claude-sonnet-4-6`. Get a key at [console.anthropic.com](https://console.anthropic.com).

```bash
npm run sync-metadata:claude:missing  # missing only
npm run sync-metadata:claude          # all photos
```

To use a specific model or provider on the fly:

```bash
node --env-file=.env scripts/generate-photo-metadata.js --provider=claude --model=claude-opus-4-6
node --env-file=.env scripts/generate-photo-metadata.js --provider=gemini --model=gemini-2.5-pro
```

## Useful Commands

```bash
# Start local site
npm run start

# Verify API keys before deploy
npm run preflight

# Deploy without AI metadata generation
npm run deploy:no-ai

# Regenerate only missing titles/descriptions (Gemini)
npm run sync-metadata:missing

# Regenerate all titles/descriptions (Gemini)
npm run sync-metadata

# Regenerate only missing titles/descriptions (Claude)
npm run sync-metadata:claude:missing

# Regenerate all titles/descriptions (Claude)
npm run sync-metadata:claude

# Test metadata generation without writing file changes
node --env-file=.env scripts/generate-photo-metadata.js --dry-run --limit=2
```

## Suggested Routine

1. Add new files to `photos/`
2. Run `npm run deploy`
3. Review `photos.json`
4. Commit and push
