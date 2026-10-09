"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import SignaturePad, { type PointGroup } from "signature_pad";
import { Eraser, Loader2 } from "lucide-react";
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
  const [signedOut, setSignedOut] = useState(false);
  // After a review attempt, missing fields are marked next to themselves too.
  const [attempted, setAttempted] = useState(false);
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
    setAttempted(true);
    if (missing.length) {
      setProblem(`To sign, ${missing.join(", ")}.`);
      return;
    }
    setProblem(null);
    setSignedOut(false);
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
          setSignedOut(outcome.code === "signed_out");
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
      <section role="status" className="grid gap-1 rounded-2xl border-2 border-emerald-600 bg-card p-4 text-base shadow-sm sm:p-6">
        <h2 className="text-lg font-semibold">Contract signed.</h2>
        <p>Your DJ will follow up with the next steps.</p>
      </section>
    );
  }

  const nameMissing = attempted && !typedName.trim();
  const drawingMissing = attempted && !hasDrawing;
  const consentMissing = attempted && !consent;
  const step = "flex size-6 shrink-0 items-center justify-center rounded-full bg-[var(--brand)] text-xs font-semibold text-[var(--brand-foreground)]";

  return (
    <section id="sign" aria-labelledby="sign-heading" className="grid scroll-mt-4 gap-5 rounded-2xl border bg-card p-4 shadow-sm sm:p-6">
      <div className="grid gap-1">
        <h2 id="sign-heading" className="text-lg font-semibold">Sign this contract</h2>
        <p className="text-sm text-muted-foreground">Nothing is signed until you confirm on the last step.</p>
      </div>
      {props.isDemo ? (
        <p className="rounded-lg border border-destructive/60 p-2 text-sm text-destructive">
          DEMO: the agreement and the consent statement below are test wording. They have not been reviewed by a lawyer.
        </p>
      ) : null}
      <div className="grid gap-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className={step}>1</span>
          <Label htmlFor="typed_name">Your full name</Label>
        </div>
        <Input
          id="typed_name"
          name="typed_name"
          autoComplete="name"
          maxLength={200}
          value={typedName}
          onChange={(e) => setTypedName(e.target.value)}
          aria-describedby="typed_name_hint"
          aria-invalid={nameMissing || undefined}
          className="h-11 text-base sm:text-sm"
        />
        <p id="typed_name_hint" className="text-xs text-muted-foreground">This contract names {props.expectedName} as the signer.</p>
      </div>
      <div className="grid gap-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className={step}>2</span>
          <span id="signature_label" className="text-sm font-medium">Your signature</span>
        </div>
        <div className={`relative rounded-xl border-2 border-dashed bg-white ${drawingMissing ? "border-destructive" : ""}`}>
          <canvas
            ref={canvasRef}
            role="img"
            aria-labelledby="signature_label"
            aria-describedby="signature_hint"
            data-testid="signature-canvas"
            className="block aspect-[3/1] w-full touch-none select-none"
          />
          <span aria-hidden className="pointer-events-none absolute bottom-3 left-4 right-4 border-b border-neutral-300" />
          {!hasDrawing ? (
            <span aria-hidden className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-neutral-400">
              Sign here
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p id="signature_hint" className="text-xs text-muted-foreground">
            Sign with your finger, a stylus or the mouse. Scroll the page outside this box.
          </p>
          <Button type="button" variant="outline" className="min-h-11 sm:min-h-9" onClick={clear} disabled={pending || !hasDrawing}>
            <Eraser aria-hidden />
            Clear signature
          </Button>
        </div>
      </div>
      <div className="grid gap-2">
        <div className="flex items-center gap-2">
          <span aria-hidden className={step}>3</span>
          <span className="text-sm font-medium">Your consent</span>
        </div>
        <label className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${consentMissing ? "border-destructive" : ""}`}>
          <input
            type="checkbox"
            name="consent"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            aria-invalid={consentMissing || undefined}
            className="mt-0.5 size-5 shrink-0 accent-primary"
          />
          <span>{props.consentText}</span>
        </label>
      </div>
      {problem ? (
        <div role="alert" className="grid gap-1 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          <p>{problem}</p>
          {signedOut ? (
            <p>
              <a className="font-medium underline" href="/login" target="_blank" rel="noopener">
                Sign in again in a new tab
              </a>
              , then come back here and sign.
            </p>
          ) : null}
        </div>
      ) : null}
      {confirming ? (
        <div role="dialog" aria-label="Confirm signing" className="grid gap-3 rounded-xl border-2 border-[var(--brand)] p-4">
          <p className="font-medium">Sign this contract as {typedName.trim()}?</p>
          <p className="text-sm text-muted-foreground">Your typed name, drawn signature and consent will be recorded with this exact contract. A signed contract can&apos;t be changed.</p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" className="min-h-11" onClick={() => setConfirming(false)} disabled={pending}>
              Go back
            </Button>
            <Button type="button" className="min-h-11 px-5" style={{ background: "var(--brand)", color: "var(--brand-foreground)" }} onClick={sign} disabled={pending}>
              {pending ? (
                <>
                  <Loader2 aria-hidden className="animate-spin" /> Signing…
                </>
              ) : (
                "Sign contract"
              )}
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button type="button" className="min-h-11 px-5 max-sm:w-full" style={{ background: "var(--brand)", color: "var(--brand-foreground)" }} onClick={review} disabled={pending}>
            Review and sign…
          </Button>
        </div>
      )}
    </section>
  );
}
