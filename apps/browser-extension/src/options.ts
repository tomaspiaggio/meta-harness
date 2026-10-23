export {};

const form = document.querySelector<HTMLFormElement>("#pair");
const input = document.querySelector<HTMLInputElement>("#code");
const status = document.querySelector<HTMLElement>("#status");
function report(message: string) {
  if (status) status.textContent = message;
}
form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const pairing = JSON.parse(atob(input?.value.trim() ?? ""));
    if (
      !Number.isInteger(pairing.port) ||
      pairing.port < 1024 ||
      pairing.port > 65535 ||
      !/^[a-zA-Z0-9_-]{43}$/.test(pairing.token)
    )
      throw new Error("Invalid pairing code.");
    await chrome.storage.local.set({
      pairing: { port: pairing.port, token: pairing.token },
    });
    if (input) input.value = "";
    await chrome.runtime.sendMessage({ type: "reconnect" });
    report("Pairing saved. Connecting to the worker on this machine…");
  } catch {
    report(
      "Pairing failed. Copy a new code from pnpm browser:pair on this machine.",
    );
  }
});
document.querySelector("#disconnect")?.addEventListener("click", async () => {
  await chrome.storage.local.remove("pairing");
  await chrome.runtime.sendMessage({ type: "reconnect" });
  report("Disconnected. This browser no longer accepts harness commands.");
});
const refresh = async () => {
  const result = await chrome.runtime.sendMessage({ type: "status" });
  report(
    result.connected
      ? "Connected to your worker. Background browser tasks are available."
      : result.paired
        ? "Paired; waiting for this machine’s worker. It will reconnect automatically."
        : "Not paired.",
  );
};
void refresh();
setInterval(() => void refresh(), 3000);
