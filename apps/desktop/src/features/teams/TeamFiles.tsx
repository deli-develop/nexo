import { useEffect, useState } from "react";

import { Button } from "../../components/ui/Button";
import { Icon } from "../../components/ui/Icon";
import { fileSize } from "../../lib/format";
import { saveFile } from "../../lib/native";
import { openTeamFile, type SealedFile } from "../../lib/teams";

/**
 * A post's files: pictures drawn, everything else as a row to save.
 *
 * Every one is fetched as ciphertext and opened on this device -- the bucket
 * holds nothing it can read -- and a picture is shown from an object URL that
 * is revoked when the post leaves the screen.
 */
export function TeamFiles({ files, leftOut }: { files: SealedFile[]; leftOut: number }) {
  if (files.length === 0 && leftOut === 0) return null;
  const pictures = files.filter((file) => file.mime.startsWith("image/"));
  const others = files.filter((file) => !file.mime.startsWith("image/"));

  return (
    <div className="flex flex-col gap-2">
      {pictures.length > 0 ? (
        <div className={pictures.length === 1 ? "grid grid-cols-1" : "grid grid-cols-2 gap-1.5"}>
          {pictures.map((file) => (
            <Picture key={file.s3_key} file={file} />
          ))}
        </div>
      ) : null}
      {others.map((file) => (
        <FileRow key={file.s3_key} file={file} />
      ))}
      {leftOut > 0 ? (
        <p className="text-text-lo text-meta">
          {leftOut === 1 ? "1 more file is" : `${leftOut} more files are`} attached but not shown here.
        </p>
      ) : null}
    </div>
  );
}

function Picture({ file }: { file: SealedFile }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    void openTeamFile(file)
      .then((bytes) => {
        if (cancelled) return;
        made = URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: file.mime }));
        setUrl(made);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [file]);

  if (failed) {
    // Fail closed, and say so: not a broken-image icon, not nothing.
    return (
      <div className="rounded-control text-text-mid flex aspect-video items-center justify-center gap-2 bg-fill text-meta">
        <Icon name="alert" size={15} />
        This picture can't be opened.
      </div>
    );
  }
  return url ? (
    <img src={url} alt={file.name} className="rounded-control max-h-[420px] w-full object-cover" />
  ) : (
    <div className="shimmer rounded-control aspect-video bg-fill" />
  );
}

function FileRow({ file }: { file: SealedFile }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-control flex items-center gap-3 bg-fill px-3 py-2">
      <Icon name="file" size={18} className="text-text-lo shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="text-text-hi truncate text-body">{file.name}</p>
        <p className="text-text-lo text-meta">{fileSize(file.size)}</p>
      </div>
      <Button
        variant="ghost"
        icon="download"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await saveFile(file.name, await openTeamFile(file));
          } finally {
            setBusy(false);
          }
        }}
      >
        Save
      </Button>
    </div>
  );
}
