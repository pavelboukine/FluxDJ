import { Document, Image, Page, StyleSheet, Text, View } from "@react-pdf/renderer";
import { formatCents } from "@/lib/money";
import { ppmToPercent } from "@/lib/pricing/tax-settings";
import { formatSignedAt, type SignedContractPdfData } from "./data";

export const PDF_FONT = "DejaVuSans";

const s = StyleSheet.create({
  // lineHeight is set on individual text styles, never on the page or a
  // wrapper: react-pdf 4.9 drops the render-prop page number when the page
  // has a lineHeight, and misapplies one inherited from a View.
  page: { fontFamily: PDF_FONT, fontSize: 10, color: "#111827", paddingTop: 54, paddingBottom: 64, paddingHorizontal: 56 },
  demo: { position: "absolute", top: 20, left: 56, right: 56, fontSize: 8, fontWeight: "bold", color: "#b91c1c", textAlign: "center" },
  footerLeft: { position: "absolute", bottom: 28, left: 56, right: 160, fontSize: 7.5, color: "#6b7280" },
  // No width, height or textAlign: react-pdf 4.9 drops render-prop text with them.
  footerRight: { position: "absolute", bottom: 28, right: 56, fontSize: 7.5, color: "#6b7280" },
  business: { fontSize: 9, color: "#4b5563", marginBottom: 6 },
  title: { fontSize: 16, fontWeight: "bold", lineHeight: 1.3, marginBottom: 6 },
  subtitle: { fontSize: 9.5, color: "#374151", marginBottom: 14 },
  demoBox: { borderWidth: 1.5, borderColor: "#b91c1c", color: "#b91c1c", padding: 8, marginBottom: 14, fontWeight: "bold", fontSize: 9.5, lineHeight: 1.35 },
  h2: { fontSize: 12, fontWeight: "bold", marginTop: 14, marginBottom: 6 },
  h3: { fontSize: 10.5, fontWeight: "bold", marginTop: 10, marginBottom: 3 },
  // fontSize must sit next to lineHeight: react-pdf 4.9 resolves a unitless
  // lineHeight against its 18pt default when fontSize is only inherited.
  paragraph: { fontSize: 10, lineHeight: 1.45, marginBottom: 6 },
  parties: { flexDirection: "row", gap: 16 },
  box: { borderWidth: 0.75, borderColor: "#d1d5db", borderRadius: 4, padding: 8 },
  party: { flex: 1, borderWidth: 0.75, borderColor: "#d1d5db", borderRadius: 4, padding: 8 },
  label: { fontSize: 8, color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 2 },
  bold: { fontWeight: "bold" },
  muted: { color: "#4b5563" },
  row: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb", paddingVertical: 3 },
  headRow: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: "#9ca3af", paddingBottom: 3, fontWeight: "bold", fontSize: 9 },
  cItem: { flex: 1, paddingRight: 6 },
  cQty: { width: 34, textAlign: "right" },
  cUnit: { width: 78, textAlign: "right" },
  cTotal: { width: 82, textAlign: "right" },
  totals: { marginTop: 6, marginLeft: "auto", width: 250 },
  totalRow: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 2 },
  grand: { flexDirection: "row", justifyContent: "space-between", paddingVertical: 3, borderTopWidth: 1, borderTopColor: "#111827", fontWeight: "bold" },
  signatureBox: { borderWidth: 0.75, borderColor: "#9ca3af", borderRadius: 4, padding: 10, marginTop: 6 },
  signatureImage: { width: 240, height: 80, objectFit: "contain", marginVertical: 4 },
  signatureLine: { borderTopWidth: 0.75, borderTopColor: "#6b7280", width: 260, marginBottom: 4 },
  recordRow: { flexDirection: "row", paddingVertical: 2.5, borderBottomWidth: 0.5, borderBottomColor: "#e5e7eb" },
  recordKey: { width: 150, color: "#4b5563", paddingRight: 8 },
  recordValue: { flex: 1 },
  hash: { fontSize: 8 },
});

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ marginBottom: 5 }}>
      <Text style={s.label}>{label}</Text>
      {children}
    </View>
  );
}

function RecordRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={s.recordRow} wrap={false}>
      <Text style={s.recordKey}>{label}</Text>
      <View style={s.recordValue}>{typeof children === "string" ? <Text>{children}</Text> : children}</View>
    </View>
  );
}

/** Splits a section body into paragraphs on blank lines; single newlines stay line breaks. */
const paragraphs = (body: string) => body.split(/\n\s*\n/).map((p) => p.replace(/\s+$/, "")).filter((p) => p.length > 0);

/**
 * The signed agreement. Every value comes from SignedContractPdfData (frozen
 * contract + signing evidence). It records the client's electronic
 * signature only; it never shows or implies a countersignature by the DJ.
 * It does not contain the PDF's own hash.
 */
export function SignedContractDocument({ data, signaturePng, generatedAt }: { data: SignedContractPdfData; signaturePng: Buffer; generatedAt: Date }) {
  const money = (cents: number) => formatCents(cents, data.contract.currency);
  const signed = formatSignedAt(data.signature.signedAt, data.event.timezone);
  const { business, client, event, commercial, signature, contract } = data;
  return (
    <Document
      title={`Signed contract: ${contract.title}`}
      author={business.legalName}
      subject={`Signed contract ${contract.id}`}
      creator="Flux DJ"
      producer="Flux DJ"
      language="en-CA"
      creationDate={generatedAt}
      modificationDate={generatedAt}
    >
      <Page size="LETTER" style={s.page}>
        {contract.isDemo ? (
          <Text style={s.demo} fixed>
            DEMO, NOT FOR CLIENT USE · Test agreement and consent wording, not reviewed by a lawyer
          </Text>
        ) : null}
        <Text style={s.footerLeft} fixed>
          {business.legalName} · Contract {contract.id}
        </Text>
        <Text style={s.footerRight} fixed render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />

        <Text style={s.business}>{business.displayName ? `${business.displayName} · ${business.legalName}` : business.legalName}</Text>
        <Text style={s.title}>{contract.title}</Text>
        <Text style={s.subtitle}>
          Signed electronically by {signature.typedName} on {signed.local}.
        </Text>
        {contract.isDemo ? (
          <Text style={s.demoBox}>
            DEMO, NOT FOR CLIENT USE. This is test wording for trying Flux DJ, not a real agreement. The agreement and the consent statement have not
            been reviewed by a lawyer.
          </Text>
        ) : null}

        <Text style={s.h2}>Parties</Text>
        <View style={s.parties} wrap={false}>
          <View style={s.party}>
            <Field label="Business">
              <Text style={s.bold}>{business.legalName}</Text>
              {business.displayName ? <Text style={s.muted}>Operating as {business.displayName}</Text> : null}
              {business.address ? <Text>{business.address}</Text> : null}
              {business.contactEmail ? <Text>{business.contactEmail}</Text> : null}
            </Field>
          </View>
          <View style={s.party}>
            <Field label="Client">
              <Text style={s.bold}>{client.name}</Text>
              <Text>{client.email}</Text>
              {client.phone ? <Text>{client.phone}</Text> : null}
            </Field>
          </View>
        </View>
        <View style={[s.box, { marginTop: 8 }]} wrap={false}>
          <Field label="Event">
            <Text style={s.bold}>{event.title}</Text>
            <Text>
              {event.date}
              {event.venueName ? ` · ${event.venueName}` : ""}
            </Text>
            {event.venueAddress ? <Text>{event.venueAddress}</Text> : null}
          </Field>
        </View>

        <Text style={s.h2}>Agreement</Text>
        {contract.sections.map((section, i) => (
          <View key={i}>
            <Text style={s.h3} minPresenceAhead={36}>
              {section.heading}
            </Text>
            {paragraphs(section.body).map((p, j) => (
              <Text key={j} style={s.paragraph}>
                {p}
              </Text>
            ))}
          </View>
        ))}

        {/* Normal-length price tables stay together with their totals; very long ones may break across pages. */}
        <View wrap={commercial.lines.length > 14}>
          <Text style={s.h2} minPresenceAhead={80}>
            Agreed price and payment terms
          </Text>
          <View style={s.headRow} fixed={false}>
            <Text style={s.cItem}>Item</Text>
            <Text style={s.cQty}>Qty</Text>
            <Text style={s.cUnit}>Unit price</Text>
            <Text style={s.cTotal}>Amount</Text>
          </View>
          {commercial.lines.map((line, i) => (
            <View key={i} style={s.row} wrap={false}>
              <View style={s.cItem}>
                <Text>{line.name}</Text>
                {line.source === "included" ? <Text style={[s.muted, { fontSize: 8.5 }]}>Included in the package</Text> : null}
                {line.source === "required" ? <Text style={[s.muted, { fontSize: 8.5 }]}>Required for the event logistics</Text> : null}
              </View>
              <Text style={s.cQty}>{line.quantity}</Text>
              <Text style={s.cUnit}>{line.source === "included" ? "Included" : money(line.unitPriceCents)}</Text>
              <Text style={s.cTotal}>{line.source === "included" ? "Included" : money(line.lineTotalCents)}</Text>
            </View>
          ))}
          <View style={s.totals} wrap={false}>
            <View style={s.totalRow}>
              <Text>Subtotal</Text>
              <Text>{money(commercial.subtotalCents)}</Text>
            </View>
            {commercial.taxes.map((t, i) => (
              <View key={i} style={s.totalRow}>
                <Text>
                  {t.label} ({ppmToPercent(t.ratePpm)}%)
                </Text>
                <Text>{money(t.amountCents)}</Text>
              </View>
            ))}
            {commercial.taxes.length === 0 ? (
              <View style={s.totalRow}>
                <Text>Taxes</Text>
                <Text>None</Text>
              </View>
            ) : null}
            <View style={s.grand}>
              <Text>Total, including taxes</Text>
              <Text>{money(commercial.totalCents)}</Text>
            </View>
            <View style={s.totalRow}>
              <Text>Deposit due on signing ({commercial.depositPercent}%)</Text>
              <Text>{money(commercial.depositCents)}</Text>
            </View>
            <View style={s.totalRow}>
              <Text>Balance</Text>
              <Text>{money(commercial.balanceCents)}</Text>
            </View>
            <View style={s.totalRow}>
              <Text>Balance due</Text>
              <Text>{commercial.balanceDueDate ?? "Not specified in this agreement"}</Text>
            </View>
          </View>
        </View>

        <View wrap={false}>
          <Text style={s.h2}>Client signature</Text>
          <View style={s.signatureBox}>
            {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image has no alt; the typed name follows */}
            <Image style={s.signatureImage} src={{ data: signaturePng, format: "png" }} />
            <View style={s.signatureLine} />
            <Text style={s.bold}>{signature.typedName}</Text>
            <Text>Signed electronically on {signed.local}</Text>
            <Text style={s.muted}>{signed.utc}</Text>
          </View>
          <Text style={[s.muted, { fontSize: 8.5, marginTop: 6 }]}>
            This document records the client&apos;s electronic signature only. It does not contain a signature by {business.legalName.replace(/\.+$/, "")}.
          </Text>
        </View>

        <View break>
          <Text style={s.h2}>Signing record</Text>
          <RecordRow label="Contract identifier">{contract.id}</RecordRow>
          <RecordRow label="Contract content SHA-256">
            <Text style={s.hash}>{contract.contentSha256}</Text>
            <Text style={[s.muted, { fontSize: 8 }]}>Identifies the agreed text, terms and parties. It is not a hash of this PDF file.</Text>
          </RecordRow>
          <RecordRow label="Typed name">{signature.typedName}</RecordRow>
          <RecordRow label="Verified signer email">{signature.signerEmail}</RecordRow>
          <RecordRow label="Signed at">{`${signed.local}\n${signed.utc}`}</RecordRow>
          <RecordRow label="Signature image SHA-256">
            <Text style={s.hash}>{signature.signatureSha256}</Text>
          </RecordRow>
          <RecordRow label={`Consent (${signature.consentVersion})`}>{signature.consentText}</RecordRow>
          <RecordRow label="IP address">{signature.clientIp ?? "Not recorded (not reliably known for this request)"}</RecordRow>
          <RecordRow label="Browser (user agent)">{signature.userAgent ?? "Not recorded"}</RecordRow>
          <Text style={[s.muted, { fontSize: 8, marginTop: 10 }]}>
            Identity was confirmed by a verified email sign-in matching the signer named in this contract. This PDF was generated by Flux DJ from
            the frozen contract and the stored signing record.
          </Text>
        </View>
      </Page>
    </Document>
  );
}
