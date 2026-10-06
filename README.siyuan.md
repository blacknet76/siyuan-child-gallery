# Child Gallery

Show the document’s child pages as clickable cards with titles, descriptions and image previews.

![Child Gallery overview with three child-document cards](docs/screenshots/child-gallery-overview.png)

## Features

* Depths 1–3 with native document order and nested hierarchy.
* Vertical or horizontal cards; automatic or 1–4 columns.
* Content-image previews, local gradient fallbacks and adaptive small-image presentation.
* Text-only mode and independent settings saved in each gallery block.
* Native navigation and English/German interface.

## Use and settings

Type `/gallery` and select **Child Gallery**, or use the editor toolbar action. Select a card to open its document.

Open **Gallery settings** to choose **Card layout**, **Columns** and **Depth**. Turn **Show previews** off for text-only cards; titles and descriptions remain visible. Changes to child pages appear on the next gallery render; reopen the document if needed.

## Compatibility and privacy

Requires **SiYuan 3.8.3+** and a normal notebook; encrypted notebooks are unsupported. Fallback covers are generated locally without an external image service. Existing HTTP(S) image sources in note content can cause external requests when displayed.

## More information

See the [full documentation on GitHub](https://github.com/blacknet76/siyuan-child-gallery#readme) for usage, limitations and installation. Distributed under the [MIT license](LICENSE); see [third-party notices](THIRD_PARTY_NOTICES.md).
