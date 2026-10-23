"use client";
import { type AgentProvider, modelSuggestions } from "@harness/core/models";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
export function ModelPicker({
  provider,
  value,
  onChange,
  disabled = false,
  label = "Model",
}: {
  provider: AgentProvider;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState("");
  const options = modelSuggestions[provider];
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <select
        aria-label={label}
        disabled={disabled}
        value={custom ? "__custom__" : (value ?? "")}
        className="h-8 max-w-48 rounded-md border bg-background px-2 text-xs"
        onChange={(event) => {
          if (event.target.value === "__custom__") {
            setCustom(true);
            setDraft(value ?? "");
          } else {
            setCustom(false);
            onChange(event.target.value || null);
          }
        }}
      >
        <option value="">Provider default</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
        {value && !options.some((option) => option.id === value) && (
          <option value={value}>{value}</option>
        )}
        <option value="__custom__">Custom model…</option>
      </select>
      {custom && (
        <div className="flex max-w-72 gap-1">
          <Input
            aria-label={`${label} ID`}
            placeholder={provider === "claude" ? "claude-…" : "gpt-…"}
            value={draft}
            disabled={disabled}
            maxLength={160}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8 min-w-0 text-xs"
          />
          <Button
            type="button"
            size="sm"
            disabled={disabled || !draft.trim()}
            onClick={() => {
              onChange(draft.trim());
              setCustom(false);
            }}
          >
            Apply
          </Button>
        </div>
      )}
    </div>
  );
}
