# Screenshot checklist

Drop PNG files into this folder with the exact filenames below. The main [README](../../README.md) references these paths, so once a file exists it renders automatically.

Recommended capture settings:
- **Width:** 1200–1600 px (high-DPI / Retina is fine — GitHub scales down)
- **Format:** PNG
- **Crop:** tight to the relevant UI, no desktop chrome
- **Theme:** whichever (dark or light) looks cleaner — be consistent across all 6
- **Sensitive data:** blur or replace real company names, your email, API keys, resume content

## The 6 shots

### `01-dashboard.png` — hero
The main app dashboard. Show the stats cards, status breakdown chart, and recent applications table. This is the first image a visitor sees, so make it look populated — seed a few example rows (Acme, Globex, Initech) if yours has sensitive data.

### `02-install-extension.png` — Chrome install
`chrome://extensions` page **after** loading the unpacked extension. The JobTracker card should be visible with Developer mode toggled on in the top-right. One screenshot is enough — no need for separate shots of each install step.

### `03-settings-resume.png` — Resume upload
The app's Settings page, scrolled to the **Resume** section. Show either the upload dropzone (empty) or a successfully uploaded resume with the filename visible. Do **not** show actual resume text content.

### `04-extension-popup.png` — Extension in action
The extension popup open on top of a real job posting (LinkedIn / Lever / Greenhouse). Show the extracted job title + company fields filled in, with the **Save Application** and **Analyze Keywords** buttons visible. Pick a public posting so you're not leaking anything private.

### `05-keyword-analysis.png` — Match results
The keyword analysis result view (either in the extension popup or the app detail page — whichever looks better). Show matched keywords and missing keywords clearly.

### `06-settings-llm.png` — LLM config
Settings page, scrolled to the LLM provider section. Show the provider dropdown (OpenAI / Gemini / Anthropic) and the API key input. **Make sure the API key field is empty or masked** before capturing.

## After you add them

Preview the README at <https://github.com/taejunoh/easy-job-application-tracker> (or locally with a markdown preview) to verify all 6 images render at the right size. If anything looks too large, crop tighter rather than resizing down.
