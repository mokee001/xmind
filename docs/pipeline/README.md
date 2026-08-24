# EchooO AI Image Pipeline

This folder is the project-level source of truth for the AI photo selection,
template routing, image processing, rendering, and QA workflow.

## Source Of Truth

1. `AI_IMAGE_PIPELINE_FULL_WORKFLOW.md`
   Defines the global end-to-end workflow and execution priority.

2. `TEMPLATE_PACKAGE_SPEC.md`
   Defines how each template package must be structured and consumed.

## Project Rule

Any implementation that runs the full image pipeline should follow this order:

1. Local or device-side hard filtering.
2. Lightweight preview generation.
3. Vision-based coarse screening.
4. Qualified image pool creation.
5. Template summary loading.
6. Template routing.
7. Selected template package loading.
8. Slot-aware final selection.
9. Template-driven image processing.
10. Template rendering.
11. Final review and targeted revision.
12. Return the final asset and QA status.

## Current Prototype Gap

The current template lab and Flutter prototype are still an early local
workbench. They may support manual template switching and local fallback
selection, but future work should move toward the workflow above instead of
adding more one-off template-specific logic.

## Template Package Direction

Each template should become a standalone package with at least:

- `summary.yaml`
- `template.json`
- `processing.json`
- `review.json`
- `preview.png`

Template files should declare required capabilities, such as crop, cutout,
segmentation, OCR, or review, without binding the template to a specific model
or vendor.
