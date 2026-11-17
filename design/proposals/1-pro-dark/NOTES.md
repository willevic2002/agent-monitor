Idea: Linear/Vercel-style flat dark UI; chat rows are borderless with a hairline divider and a muted role label; tags/pills lose fills and glow.
Palette: neutral greys (#0a0a0a to #ededed), single muted indigo accent (#8b93d9), red only for errors/stop.
Fonts: Inter/Geist/system sans for UI, existing --mono only for numbers, logs and tool names.
CSS can't change: the 3D brain's node/edge colours and the SVG ring/wires live in brain.js/three.js, and per-agent colours set inline stay as they are.
