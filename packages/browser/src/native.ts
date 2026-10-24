import type { Page } from "patchright";

/**
 * Browser-native UI (passkey sheets, alert/confirm/prompt, select popups) is
 * drawn outside the page, so it never appears in the live stream or in
 * screenshots, yet it captures input and leaves everyone stuck. Neutralize it.
 */
export type NativeNotice = { kind: string; message: string; at: number };

export async function tameNativeUi(
  page: Page,
  notice: (value: NativeNotice) => void,
) {
  // A silent virtual authenticator replaces the native passkey sheet. It holds
  // no credentials, so sites fall back to "Try another way" / password. The CDP
  // session must stay attached for the authenticator to exist.
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("WebAuthn.enable", { enableUI: false });
    await session.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: false,
        automaticPresenceSimulation: false,
      },
    });
  } catch {
    // Older browsers without the WebAuthn domain keep their default behavior.
  }
  // Alerts are acknowledged; confirm/prompt are cancelled (the safe choice for
  // "Are you sure?"), and the text is reported so the agent or person knows.
  page.on("dialog", (dialog) => {
    notice({
      kind: dialog.type(),
      message: dialog.message().slice(0, 300),
      at: Date.now(),
    });
    const accept = ["alert", "beforeunload"].includes(dialog.type());
    void (accept ? dialog.accept() : dialog.dismiss()).catch(() => {});
  });
}

/** If the point is on a <select>, return its options instead of clicking. */
export async function selectAt(page: Page, x: number, y: number) {
  return page
    .evaluate(
      ({ x, y }) => {
        const element = document.elementFromPoint(x, y)?.closest("select");
        if (!element || element.disabled) return null;
        return {
          multiple: element.multiple,
          label:
            element.getAttribute("aria-label") ||
            element.labels?.[0]?.textContent?.trim() ||
            element.name ||
            "Choose an option",
          options: Array.from(element.options)
            .slice(0, 300)
            .map((option) => ({
              value: option.value,
              label: (option.label || option.textContent || "")
                .trim()
                .slice(0, 120),
              selected: option.selected,
              disabled: option.disabled,
            })),
        };
      },
      { x, y },
    )
    .catch(() => null);
}

/** Choose an option in the <select> at the point, firing the page's events. */
export async function chooseAt(
  page: Page,
  x: number,
  y: number,
  value: string,
) {
  const handle = await page.evaluateHandle(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest("select") ?? null,
    { x, y },
  );
  const element = handle.asElement();
  if (!element) throw new Error("That dropdown is no longer there.");
  await element.selectOption(value);
}
