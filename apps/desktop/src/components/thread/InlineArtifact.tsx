import { memo } from "react";
import type { ArtifactBlock } from "@ai4s/shared";
import { fileInspectorFromBlock } from "@/lib/artifacts";
import { FilePreviewInspector } from "@/components/inspector/FilePreviewInspector";

/** A real workspace preview placed at the exact point where the agent invoked
 *  `present_artifact`. It reuses the inspector renderers, so inline and panel
 *  modes never disagree about how a file type should look. */
export const InlineArtifact = memo(function InlineArtifact({
  block,
}: {
  block: ArtifactBlock;
}) {
  const inspector = fileInspectorFromBlock(block);
  if (inspector.variant === "notebook-file") return null;
  return (
    <div className="h-[min(460px,58vh)] min-h-72 w-full">
      <FilePreviewInspector
        data={inspector}
        embedded
        title={block.presentation?.title}
      />
    </div>
  );
});
