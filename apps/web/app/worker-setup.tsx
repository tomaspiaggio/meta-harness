export function WorkerSetup() {
  return (
    <div className="grid gap-2 text-sm text-muted-foreground">
      <p>
        Enroll a device to copy its setup instructions. Paste them into a coding
        agent on that device; they contain the commands and enrollment
        credential, and tells the agent how to guide you through login, browser
        setup and verification.
      </p>
      <p className="text-xs">
        Keep the copied setup private. It grants access as this worker. A
        Markdown download is also available. Revoke the worker here if the setup
        is shared accidentally.
      </p>
    </div>
  );
}
