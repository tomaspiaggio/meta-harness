import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = {
  title: "Meta Harness",
  description: "A durable place for your work.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
