# MermaidTeaRAGs Component

React component wrapper for Mermaid diagrams with automatic TeaRAGs theme switching based on Docusaurus color mode (light/dark).

## Usage

1. **Import the component** in your MDX file:

```mdx
import MermaidTeaRAGs from '@site/src/components/MermaidTeaRAGs';
```

2. **Use the component** with Mermaid diagram code:

```mdx
<MermaidTeaRAGs>
{`
flowchart LR
    A[Node A] --> B[Node B]
    B --> C[Node C]
`}
</MermaidTeaRAGs>
```

## Theme Colors

### Dark Theme (auto-applied when Docusaurus is in dark mode)
- Background: Transparent with dark overlays
- Primary: Gold (#d4af37) - borders, lines, text
- Backgrounds: Dark grays (#1a1a1a, #2d2d2d, #3d3d3d) with transparency

### Light Theme (auto-applied when Docusaurus is in light mode)
- Background: Transparent with light overlays
- Primary: Gold (#d4af37) - borders
- Text: Dark (#2d2d2d)
- Backgrounds: White/beige (#ffffff, #f5f5dc) with transparency

## Color Palette

| Color | Hex | Usage |
|-------|-----|-------|
| Gold | `#d4af37` | Primary accent, borders, lines |
| Dark Gray | `#2d2d2d` | Text (light theme), backgrounds (dark theme) |
| Light Beige | `#f5f5dc` | Backgrounds (light theme) |
| Black | `#1a1a1a` | Deep backgrounds (dark theme) |

## Examples

### Simple Flowchart

```mdx
<MermaidTeaRAGs>
{`
flowchart TB
    User[User] --> Agent[AI Agent]
    Agent --> TeaRAGs[TeaRAGs Server]
`}
</MermaidTeaRAGs>
```

### Complex Architecture Diagram

See `/docs/architecture/overview.md` for a full example.

## Notes

- The component automatically detects Docusaurus color mode and applies the appropriate theme
- All custom `style` declarations in the diagram code are preserved
- The component wraps Docusaurus's native `@theme/Mermaid` component
- Transparency allows diagrams to blend seamlessly with page background
