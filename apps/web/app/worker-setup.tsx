export function WorkerSetup() {
  return (
    <div className="grid gap-2 text-sm text-muted-foreground">
      <p>
        Enroll a device to download a Markdown setup guide. Give the file to a
        coding agent on that device; it contains the commands and enrollment
        credential, and tells the agent how to guide you through login, browser
        setup and verification.
      </p>
      <p className="text-xs">
        Keep the downloaded file private. It grants access as this worker.
        Revoke the worker here if the file is lost.
      </p>
    </div>
  );
}
