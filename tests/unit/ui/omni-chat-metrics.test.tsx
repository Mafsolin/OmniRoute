// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import ProviderMetrics from "../../../src/app/(dashboard)/dashboard/playground/components/ProviderMetrics";
import { DeliveryTracker } from "../../../src/lib/playground/deliveryMetrics";
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
afterEach(cleanup);
it("labels unknown and burst delivery without displaying reported-output rate as visible TPS", () => {
  let now = 0;
  const tracker = new DeliveryTracker(() => now);
  now = 100; tracker.text(); now = 500; tracker.text(); now = 1000;
  const unknown = tracker.finish({ completion_tokens: 300 });
  const { rerender } = render(<ProviderMetrics metrics={unknown} />);
  expect(screen.getByText(/tpsUnavailable/)).toBeTruthy();
  expect(screen.queryByText(/300.0 t\/s/)).toBeNull();
  const burst = tracker.finish({ completion_tokens: 3000, completion_tokens_details: { reasoning_tokens: 2800 } });
  expect(burst.visibleTokens).toBe(200);
  expect(burst.visibleTps).toBeNull();
  expect(burst.tpsKind).toBe("burst");
  rerender(<ProviderMetrics metrics={burst} />);
  expect(screen.getByText(/burstDelivery/)).toBeTruthy();
  expect(screen.getByTitle("firstTextTitle").textContent).toContain("TTFT 100ms");
  rerender(<ProviderMetrics metrics={tracker.finish()} />);
  expect(screen.getByTitle("tokenCountsTitle").textContent).toContain("—↑ —↓");
});
