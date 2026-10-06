# Child Gallery

[Deutsch](README.de-DE.md)

Turn the document’s child pages into a gallery of clickable cards, with titles, short descriptions and image previews. Each gallery follows the document that contains it and keeps its own settings.

Requires **SiYuan 3.8.3+** and a normal notebook. The interface is available in English and German.

![Three child pages with a cover image, generated gradient and small contained image](docs/screenshots/child-gallery-overview.png)

## Features

* Child-document galleries at depths 1–3, preserving SiYuan’s native order and hierarchy.
* Vertical or horizontal cards with automatic or 1–4 columns.
* Titles, descriptions and the first suitable content-image preview.
* Locally generated gradient covers for pages without a usable image.
* Adaptive presentation of small raster images and an optional text-only mode.
* Native document navigation with click, Enter or Space; independent settings saved in each gallery block.

## Insert and use

1. Open the document whose child pages you want to show.
2. Type `/gallery` and select **Child Gallery** from SiYuan’s slash menu. You can also use the **Child Gallery** editor toolbar action; availability follows SiYuan’s entry preferences.
3. Select a card to open its document.
4. Use the **Gallery settings** button in the gallery header to adjust its presentation.

Titles appear first, followed by descriptions and previews. Adding another gallery does not change the settings of existing galleries.

## Depth and hierarchy

**Depth 1** shows direct children. **Depth 2** also includes their children, and **Depth 3** adds one further level. The containing document itself is excluded.

Descendants appear beneath their own parent cards with indentation. Sibling order and hidden-document filtering follow SiYuan’s document tree. A failed deeper listing leaves its parent card and other branches available.

![Five cards showing a three-level child-document hierarchy](docs/screenshots/child-gallery-hierarchy.png)

## Gallery settings

| Setting           | Choices                   | Default   |
| ----------------- | ------------------------- | --------- |
| **Card layout**   | Vertical / Horizontal     | Vertical  |
| **Columns**       | Automatic / 1 / 2 / 3 / 4 | Automatic |
| **Depth**         | 1 / 2 / 3                 | 1         |
| **Show previews** | On / off                  | On        |

Settings are stored locally in the gallery block. Layout and columns apply to every sibling group; the layout adapts to the available width.

Turn **Show previews** off for text-only cards. Titles and descriptions remain visible; all images and generated gradients disappear.

![Text-only cards with the native Show previews setting unchecked](docs/screenshots/child-gallery-text-only.png)

## Preview images and descriptions

Each card uses the first suitable image in its document content and the first suitable normal paragraph. Document icons and cover metadata are not used as previews. Headings, lists, tables, technical blocks and distinct image captions are excluded from descriptions, which are displayed in up to three lines.

Images use three presentations:

* **COVER:** a suitable image fills the preview area.
* **CONTAINED:** a recognized small raster image stays centered at no more than its natural size over a generated gradient when filling the area would require more than 1.5× enlargement. Resizing can change this classification.
* **FALLBACK:** when no usable image exists or loading fails, a locally generated gradient fills the preview area. Its colors remain stable for that document and blend with the host theme.

Real images take priority. SVG and unrecognized image formats retain normal cover presentation. Unsupported or unsafe image sources are ignored. Preview failures leave the title card available.

## Installation

Child Gallery is not yet listed in SiYuan’s Marketplace. Use **package.zip** from a [project release](https://github.com/blacknet76/siyuan-child-gallery/releases), when available, or build it locally as described below.

1. Extract the ZIP contents directly into `data/plugins/siyuan-child-gallery/` inside the SiYuan workspace. Do not add an extra enclosing folder.
2. Enable **Child Gallery** under **Marketplace → Downloaded**.
3. Reload SiYuan after replacing an installed package.

The build does not install the plugin automatically.

## Compatibility and limitations

* Requires **SiYuan 3.8.3+**. Normal notebooks are supported; encrypted notebooks are unsupported.
* Desktop and the browser-mobile frontend have been live-tested. Native Android/iOS apps, older-runtime execution, export and read-only modes do not have established live coverage. No exhaustive platform or theme compatibility is claimed.
* Structure and content changes appear when SiYuan renders the gallery again. Reopen the document if needed; there is no polling or dedicated refresh button.
* Depth limits levels, not the number of documents or their content size. Very large hierarchies can take time; there is no pagination or silent truncation.
* Gallery blocks are disabled in SiYuan’s publishing mode. If the plugin is unavailable, SiYuan retains the saved block configuration as text.

## Privacy and network behavior

Child Gallery reads document information through SiYuan’s local APIs. It generates fallback covers locally and uses no external fallback-image service.

Preview images can reference HTTP(S) sources already present in note content. Displaying those images can cause SiYuan or the browser to request the external source. Remote images therefore require their usual network access.

## Development

Use Node.js 24+ and pnpm 11 (repository pin: `pnpm@11.4.0`).

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run format:check
pnpm run dev --no-watch
pnpm run build
pnpm run validate:package
pnpm run validate:package:build
```

`pnpm run dev` watches and writes development runtime files to the repository root. `pnpm run build` creates the production `dist/` and installable `package.zip`, including the four READMEs and three documentation screenshots. Generated build outputs are ignored by Git.

`pnpm run validate:package` checks the existing distribution. `pnpm run validate:package:build` builds and validates fresh production output in a temporary directory. SiYuan supplies the plugin API; the build follows the [official plugin sample](https://github.com/siyuan-note/plugin-sample).

## License

Child Gallery is distributed under the [MIT license](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for retained attributions and generated build helpers, and the [project repository](https://github.com/blacknet76/siyuan-child-gallery) for source and documentation.
