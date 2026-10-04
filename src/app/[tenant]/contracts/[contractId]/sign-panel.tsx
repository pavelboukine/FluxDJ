"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import SignaturePad, { type PointGroup } from "signature_pad";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SIGNATURE_EXPORT_HEIGHT, SIGNATURE_EXPORT_WIDTH, type SignResult } from "@/lib/contracts/signing";
import { signContract } from "./actions";

type Props = {
  slug: string;
  contractId: string;
  contentSha256: string;
  consentVersion: string;
  consentText: string;
  isDemo: boolean;
  expectedName: string;
};

/**
 * Typed name, drawn signature and explicit consent, then a final
 * confirmation. The drawing lives only in this page's memory: it is never
 * saved to localStorage or sent anywhere except the signing request. It
 * survives resizes and orientation changes (strokes are rescaled), and
 * failed submissions keep every input as typed and drawn.
 */
export function SignPanel(props: Props) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const padRef = useRef<SignaturePad | null>(null);
  const widthRef = useRef(0);
  const [typedName, setTypedName] = useState("");
  const [consent, setConsent] = useState(false);
  const [hasDrawing, setHasDrawing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [result, setResult] = useState<SignResult | null>(null);
  const [pending, start] = useTransition();

  /** Sizes the canvas to its box (device pixels) and redraws scaled strokes. */
  const fit = useCallback(() => {
    const canvas = canvasRef.current;
    const pad = padRef.current;
    if (!canvas || !pad) return;
    const cssWidth = canvas.offsetWidth;
    const cssHeight = canvas.offsetHeight;
    if (cssWidth === 0 || cssWidth === widthRef.current) return; // height-only changes (mobile toolbars) keep the drawing as is
    const factor = widthRef.current ? cssWidth / widthRef.current : 1;
    const strokes: PointGroup[] = pad.toData().map((group) => ({
      ...group,
      points: group.points.map((point) => ({ ...point, x: point.x * factor, y: point.y * factor })),
    }));
    const ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssHeight * ratio);
    canvas.getContext("2d")?.scale(ratio, ratio);
    widthRef.current = cssWidth;
    pad.clear();
    if (strokes.length) pad.fromData(strokes);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pad = new SignaturePad(canvas, { penColor: "#111827", minWidth: 1, maxWidth: 2.8, backgroundColor: "rgba(0,0,0,0)" });
    padRef.current = pad;
    const onEnd = () => setHasDrawing(!pad.isEmpty());
    pad.addEventListener("endStroke", onEnd);
    fit();
    const observer = new ResizeObserver(() => fit());
    observer.observe(canvas);
    window.addEventListener("orientationchange", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("orientationchange", fit);
      pad.removeEventListener("endStroke", onEnd);
      pad.off();
      padRef.current = null;
    };
  }, [fit]);

  function clear() {
    padRef.current?.clear();
    setHasDrawing(false);
    setConfirming(false);
  }

  /** The drawing at a fixed size, so the server sees a predictable image. */
  function exportSignature(): string | null {
    const canvas = canvasRef.current;
    if (!canvas || !padRef.current || padRef.current.isEmpty()) return null;
    const out = document.createElement("canvas");
    out.width = SIGNATURE_EXPORT_WIDTH;
    out.height = SIGNATURE_EXPORT_HEIGHT;
    out.getContext("2d")?.drawImage(canvas, 0, 0, SIGNATURE_EXPORT_WIDTH, SIGNATURE_EXPORT_HEIGHT);
    return out.toDataURL("image/png");
  }

  function review() {
    const missing = [
      typedName.trim() ? null : "type your full name",
      hasDrawing && !padRef.current?.isEmpty() ? null : "draw your signature",
      consent ? null : "check the consent box",
    ].filter(Boolean);
    if (missing.length) {
      setProblem(`To sign, ${missing.join(", ")}.`);
      return;
    }
    setProblem(null);
    setConfirming(true);
  }

  function sign() {
    const signature = exportSignature();
    if (!signature) {
      setConfirming(false);
      setProblem("To sign, draw your signature.");
      return;
    }
    setProblem(null);
    start(async () => {
      try {
        const outcome = await signContract(props.slug, props.contractId, {
          typedName,
          consentAccepted: consent,
          consentVersion: props.consentVersion,
          contentSha256: props.contentSha256,
          signature,
        });
        if (outcome.status === "signed") {
          setResult(outcome);
          router.refresh();
        } else {
          setConfirming(false);
          setProblem(outcome.message);
        }
      } catch {
        // Network failure or a server error: nothing in the form is lost.
        setConfirming(false);
        setProblem("We couldn't reach the server. Your name and signature are still here. Check your connection and try again; you won't sign twice.");
      }
    });
  }

  if (result?.status === "signed") {
    return (
      <section role="status" className="mx-auto grid w-full max-w-prose gap-1 rounded-lg border-2 border-emerald-600 p-4 text-base">
        <h2 className="text-lg font-semibold">Contract signed.</h2>
        <p>Your DJ will follow up with the next steps.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="sign-heading" className="mx-auto grid w-full max-w-prose gap-4 rounded-lg border p-4">
      <h2 id="sign-heading" className="text-lg font-semibold">Sign this contract</h2>
      {props.isDemo ? (
        <p className="rounded-md border border-destructive/60 p-2 text-sm text-destructive">
          DEMO: the agreement and the consent statement below are test wording. They have not been reviewed by a lawyer.
        </p>
      ) : null}
      <div className="grid gap-1.5">
        <Label htmlFor="typed_name">Your full name</Label>
        <Input
          id="typed_name"
          name="typed_name"
          autoComplete="name"
          maxLength={200}
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
          aria-describedby="typed_name_hint"
        />
        <p id="typed_name_hint" className="text-xs text-muted-foreground">This contract names {props.expectedName} as the signer.</p>
      </div>
      <div className="grid gap-1.5">
        <span id="signature_label" className="text-sm font-medium">Your signature</span>
        <div className="relative rounded-md border-2 border-dashed bg-white">
          <canvas
            ref={canvasRef}
            role="img"
            aria-labelledby="signature_label"
            aria-describedby="signature_hint"
            data-testid="signature-canvas"
            className="block aspect-[3/1] w-full touch-none select-none"
          />
          <span aria-hidden className="pointer-events-none absolute bottom-3 left-4 right-4 border-b border-neutral-300" />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="signature_hint" className="text-xs text-muted-foreground">Sign with your finger, a stylus or the mouse.</p>
          <Button type="button" variant="outline" size="sm" onClick={clear} disabled={pending}>
            Clear signature
          </Button>
        </div>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="consent"
          checked={consent}
          onChange={(e) => setConsent(e.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-primary"
        />
        <span>{props.consentText}</span>
      </label>
      {problem ? (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      ) : null}
      {confirming ? (
        <div role="dialog" aria-label="Confirm signing" className="grid gap-3 rounded-xl border-2 border-primary/40 p-4">
          <p className="font-medium">Sign this contract as {typedName.trim()}?</p>
          <p className="text-sm text-muted-foreground">Your typed name, drawn signature and consent will be recorded with this exact contract. A signed contract can&apos;t be changed.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={sign} disabled={pending}>
              {pending ? "Signing…" : "Sign contract"}
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)} disabled={pending}>
              Go back
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" onClick={review} disabled={pending}>
            Review and sign…
          </Button>
        </div>
      )}
    </section>
  );
}
