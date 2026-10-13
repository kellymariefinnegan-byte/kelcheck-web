// New-hire paperwork for the KelCheck portal: filling the official I-9,
// W-4 and VA-4, making the shop's own forms, and locking private ones with
// the owner's records lock before they leave the browser.
//
// Works the same in the browser and in tests: pass in pdf-lib and the HPKE
// pieces (`makePaperwork({ PDFLib, hpke })`).

export const KINDS = {
  i9: { title: "Form I-9 — Employment Eligibility", sensitive: true, official: true },
  w4: { title: "Form W-4 — Federal Withholding", sensitive: true, official: true },
  va4: { title: "Form VA-4 — Virginia Withholding", sensitive: true, official: true },
  direct_deposit: { title: "Direct Deposit Authorization", sensitive: true },
  handbook: { title: "Handbook Acknowledgment", sensitive: false },
  self_id: { title: "Voluntary Self-Identification", sensitive: false, optional: true },
  work_permit: { title: "Minor's Work Permit", sensitive: false },
};

export const SELF_ID = {
  decline: "I choose not to self-identify",
  sexes: ["Male", "Female", "I choose not to self-identify"],
  races: ["Hispanic or Latino", "White", "Black or African American", "Native Hawaiian or Other Pacific Islander",
    "Asian", "American Indian or Alaska Native", "Two or More Races", "I choose not to self-identify"],
  veterans: [
    "I identify as one or more of the protected veteran classifications (disabled veteran, recently separated veteran, active duty wartime or campaign badge veteran, Armed Forces service medal veteran)",
    "I am a veteran, but not a protected veteran",
    "I am not a veteran",
    "I choose not to self-identify",
  ],
};

export const W4_CHILD_CREDIT = 2200;  // Step 3(a), 2026 form
export const W4_OTHER_DEPENDENT = 500; // Step 3(b)

const digits = (s) => String(s ?? "").replace(/\D/g, "");
const mdy = (d) => `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
export const isoToMDY = (iso) => {
  if (!iso) return "";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
};
const money = (n) => (n ? Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : "");

/// The check digit every US routing number carries.
export function routingValid(r) {
  const d = digits(r);
  if (d.length !== 9) return false;
  const n = [...d].map(Number);
  return (3 * (n[0] + n[3] + n[6]) + 7 * (n[1] + n[4] + n[7]) + (n[2] + n[5] + n[8])) % 10 === 0;
}

/// VA-4 worksheet totals from the answers.
export function va4Totals(a) {
  const personal = (a.claimSelf ? 1 : 0) + (a.claimSpouse ? 1 : 0) + Math.max(0, Number(a.dependents) || 0);
  const ageBlind = (a.age65 ? 1 : 0) + (a.spouseAge65 ? 1 : 0) + (a.blind ? 1 : 0) + (a.spouseBlind ? 1 : 0);
  return { personal, ageBlind, total: personal + ageBlind };
}

/// W-4 Step 3 total.
export function w4Credits(a) {
  return Math.max(0, Number(a.children) || 0) * W4_CHILD_CREDIT
    + Math.max(0, Number(a.otherDependents) || 0) * W4_OTHER_DEPENDENT
    + Math.max(0, Number(a.otherCredits) || 0);
}

export function makePaperwork({ PDFLib, hpke }) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;

  /// Draws a signature (PNG bytes) as big as fits in `box`, from the left.
  async function drawSignature(doc, page, png, box) {
    const img = await doc.embedPng(png);
    const aspect = img.width / img.height;
    let h = box.height, w = h * aspect;
    if (w > box.width) { w = box.width; h = w / aspect; }
    page.drawImage(img, { x: box.x, y: box.y + (box.height - h) / 2, width: w, height: h });
  }

  const rectOf = (field) => field.acroField.getWidgets()[0].getRectangle();
  const set = (form, name, value) => { if (value !== undefined && value !== null && value !== "") form.getTextField(name).setText(String(value)); };
  const check = (form, name, on) => { if (on) form.getCheckBox(name).check(); };

  // ---------------------------------------------------------------- I-9, Section 1

  /// The employee's part. Section 2 is left as boxes for the owner to fill
  /// in after seeing their documents; everything filled here is locked.
  async function fillI9(blank, a, signaturePng, today = new Date()) {
    const doc = await PDFDocument.load(blank);
    const form = doc.getForm();
    const fields = {
      "Last Name (Family Name)": a.lastName, "First Name Given Name": a.firstName,
      "Employee Middle Initial (if any)": (a.middleInitial || "").slice(0, 1),
      "Employee Other Last Names Used (if any)": a.otherLastNames || "N/A",
      "Address Street Number and Name": a.street, "Apt Number (if any)": a.apt || "N/A",
      "City or Town": a.city, "ZIP Code": digits(a.zip).slice(0, 5),
      "Date of Birth mmddyyyy": isoToMDY(a.dob), "US Social Security Number": digits(a.ssn).slice(0, 9),
      "Employees E-mail Address": a.email, "Telephone Number": a.phone,
      "Today's Date mmddyyy": mdy(today),
    };
    for (const [k, v] of Object.entries(fields)) set(form, k, v);
    // The state is printed rather than left as a dropdown, which would
    // print with its arrow.
    if (a.state) {
      const st = form.getDropdown("State");
      const r = rectOf(st);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      doc.getPage(0).drawText(a.state, { x: r.x + 3, y: r.y + 3, size: 10, font, color: rgb(0, 0, 0) });
      form.removeField(st);
    }
    const status = Number(a.status);
    check(form, `CB_${status}`, true);
    if (status === 3) set(form, "3 A lawful permanent resident Enter USCIS or ANumber", a.aNumber);
    if (status === 4) {
      set(form, "Exp Date mmddyyyy", a.workAuthExpires ? isoToMDY(a.workAuthExpires) : "N/A");
      set(form, "USCIS ANumber", a.aNumber);
      set(form, "Form I94 Admission Number", a.i94);
      set(form, "Foreign Passport Number and Country of IssuanceRow1", a.passport);
    }
    const page = doc.getPage(0);
    const sigField = form.getTextField("Signature of Employee");
    const r = rectOf(sigField);
    await drawSignature(doc, page, signaturePng, { x: r.x + 2, y: r.y + 1, width: r.width - 4, height: r.height - 2 });
    // Section 1 is done: lock what was filled and the signature box.
    const filled = [...Object.keys(fields), "CB_1", "CB_2", "CB_3", "CB_4",
      "3 A lawful permanent resident Enter USCIS or ANumber", "Exp Date mmddyyyy", "USCIS ANumber",
      "Form I94 Admission Number", "Foreign Passport Number and Country of IssuanceRow1"];
    for (const name of filled) { try { form.getField(name).enableReadOnly(); } catch { /* not on this revision */ } }
    form.removeField(sigField);
    return await doc.save();
  }

  // ---------------------------------------------------------------- W-4

  async function fillW4(blank, a, signaturePng, employer, today = new Date()) {
    const doc = await PDFDocument.load(blank);
    const form = doc.getForm();
    const f = (n) => `topmostSubform[0].Page1[0].${n}`;
    set(form, f("Step1a[0].f1_01[0]"), [a.firstName, a.middleInitial].filter(Boolean).join(" "));
    set(form, f("Step1a[0].f1_02[0]"), a.lastName);
    set(form, f("Step1a[0].f1_03[0]"), [a.street, a.apt].filter(Boolean).join(", "));
    set(form, f("Step1a[0].f1_04[0]"), `${a.city}, ${a.state} ${digits(a.zip).slice(0, 5)}`);
    const ssn = digits(a.ssn);
    set(form, f("f1_05[0]"), ssn.length === 9 ? `${ssn.slice(0, 3)}-${ssn.slice(3, 5)}-${ssn.slice(5)}` : ssn);
    check(form, f(`c1_1[${{ single: 0, joint: 1, head: 2 }[a.filing] ?? 0}]`), true);
    check(form, f("c1_2[0]"), a.twoJobs);
    if (!a.exempt) {
      const kids = Math.max(0, Number(a.children) || 0) * W4_CHILD_CREDIT;
      const others = Math.max(0, Number(a.otherDependents) || 0) * W4_OTHER_DEPENDENT;
      set(form, f("Step3_ReadOrder[0].f1_06[0]"), money(kids));
      set(form, f("Step3_ReadOrder[0].f1_07[0]"), money(others));
      set(form, f("f1_08[0]"), money(w4Credits(a)));
      set(form, f("f1_09[0]"), money(a.otherIncome));
      set(form, f("f1_10[0]"), money(a.deductions));
      set(form, f("f1_11[0]"), money(a.extraWithholding));
    }
    check(form, f("c1_3[0]"), a.exempt);
    // Employers Only: filled from Payroll Setup.
    if (employer) {
      const addr = [employer.street, [employer.city, employer.state].filter(Boolean).join(", "), employer.zip].filter(Boolean).join(" ");
      set(form, f("f1_12[0]"), [employer.legal_name, addr].filter(Boolean).join("\n"));
      set(form, f("f1_13[0]"), employer.firstDay ? isoToMDY(employer.firstDay) : "");
      set(form, f("f1_14[0]"), employer.ein);
    }
    // Step 5 is a printed line, not a box: it sits just above the
    // employer section, so it's placed from there.
    const page = doc.getPage(0);
    const emp = rectOf(form.getTextField(f("f1_12[0]")));
    const date = rectOf(form.getTextField(f("f1_13[0]")));
    const lineY = emp.y + emp.height + 25;
    await drawSignature(doc, page, signaturePng, { x: 102, y: lineY, width: 330, height: 15 });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(mdy(today), { x: date.x + 73, y: lineY + 4, size: 10, font, color: rgb(0, 0, 0) });
    form.flatten();
    return await doc.save();
  }

  // ---------------------------------------------------------------- VA-4

  async function fillVA4(blank, a, signaturePng, today = new Date()) {
    const doc = await PDFDocument.load(blank);
    const form = doc.getForm();
    const t = va4Totals(a);
    const one = (b) => (b ? "1" : "");
    if (!a.notSubject && !a.notSubjectMilitary) {
      set(form, "Claim Yourself", one(a.claimSelf));
      set(form, "Claim spouse", one(a.claimSpouse));
      set(form, "claim dependents", Number(a.dependents) > 0 ? String(Number(a.dependents)) : "");
      set(form, "personal exemptions subtotal", String(t.personal));
      set(form, "Age exemption", one(a.age65));
      set(form, "spouse age exemption", one(a.spouseAge65));
      set(form, "Blindness Exemption", one(a.blind));
      set(form, "Spouse blindness exemption", one(a.spouseBlind));
      set(form, "age and blindness subtotal", String(t.ageBlind));
      set(form, "Total exemptions", String(t.total));
      set(form, "Personal exemptions subtotal 2", String(t.personal));
      set(form, "age and blindness subtotal 2", String(t.ageBlind));
      set(form, "Total exemptions 2", String(t.total));
      set(form, "Additional withholding", money(a.extraWithholding));
    }
    check(form, "Not Subject Check 1", a.notSubject);
    check(form, "Not Subject Check 2", a.notSubjectMilitary);
    const ssn = digits(a.ssn);
    set(form, "Your Social Security Number", ssn.length === 9 ? `${ssn.slice(0, 3)}-${ssn.slice(3, 5)}-${ssn.slice(5)}` : ssn);
    set(form, "Name", [a.firstName, a.middleInitial, a.lastName].filter(Boolean).join(" "));
    set(form, "Street Address", [a.street, a.apt].filter(Boolean).join(", "));
    set(form, "City", a.city); set(form, "State", a.state); set(form, "Zip Code", digits(a.zip).slice(0, 5));
    set(form, "Date", mdy(today));
    const sig = form.getField("Signature");
    const r = rectOf(sig);
    await drawSignature(doc, doc.getPage(0), signaturePng, { x: r.x + 2, y: r.y + 1, width: r.width - 4, height: r.height - 2 });
    form.removeField(sig);
    form.flatten();
    return await doc.save();
  }

  // ---------------------------------------------------------------- The shop's own forms

  /// A plain Letter page like the POS makes: shop name, title, the answers,
  /// the statement, then signature and date.
  async function shopForm({ storeName, title, lines, statement, signaturePng, signer, today = new Date() }) {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const black = rgb(0, 0, 0), gray = rgb(0.45, 0.45, 0.45);
    const wrap = (text, f, size, width) => {
      const out = [];
      for (const para of String(text).split("\n")) {
        let line = "";
        for (const word of para.split(" ")) {
          const next = line ? `${line} ${word}` : word;
          if (f.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; } else line = next;
        }
        out.push(line);
      }
      return out;
    };
    let y = 792 - 54;
    page.drawText(storeName || "Pedestrian", { x: 54, y: y - 12, size: 12, font: bold, color: gray }); y -= 40;
    page.drawText(title, { x: 54, y, size: 22, font: bold, color: black }); y -= 18;
    page.drawLine({ start: { x: 54, y }, end: { x: 558, y }, thickness: 0.5, color: gray }); y -= 22;
    for (const [label, value] of lines) {
      const rows = wrap(value, font, 11, 340);
      page.drawText(label, { x: 54, y, size: 11, font: bold, color: black });
      rows.forEach((r, i) => page.drawText(r, { x: 214, y: y - i * 15, size: 11, font, color: black }));
      y -= Math.max(rows.length, 1) * 15 + 6;
    }
    y -= 4;
    page.drawLine({ start: { x: 54, y }, end: { x: 558, y }, thickness: 0.5, color: gray }); y -= 20;
    for (const r of wrap(statement, font, 11, 504)) { page.drawText(r, { x: 54, y, size: 11, font, color: black }); y -= 15; }
    y -= 40;
    if (signer) {
      if (signaturePng) await drawSignature(doc, page, signaturePng, { x: 54, y: y + 2, width: 260, height: 46 });
      page.drawLine({ start: { x: 54, y }, end: { x: 314, y }, thickness: 0.8, color: black });
      page.drawText(`Signature — ${signer}`, { x: 54, y: y - 11, size: 9, font, color: black });
      page.drawText(today.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), { x: 344, y: y + 4, size: 11, font, color: black });
      page.drawLine({ start: { x: 344, y }, end: { x: 494, y }, thickness: 0.8, color: black });
      page.drawText("Date", { x: 344, y: y - 11, size: 9, font, color: black });
    } else {
      page.drawText(`Completed ${today.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}`, { x: 54, y, size: 11, font, color: black });
    }
    return await doc.save();
  }

  // ---------------------------------------------------------------- The records lock

  const enc = new TextEncoder();
  /// Locks bytes to the shop's public key, exactly as the POS does
  /// (RecordsCrypto.sealFile): "PEDSEAL1" + encapsulated key + ciphertext.
  async function sealFile(bytes, publicKeyBase64, context) {
    const { CipherSuite, HkdfSha256, DhkemX25519HkdfSha256, Chacha20Poly1305 } = hpke;
    const suite = new CipherSuite({ kem: new DhkemX25519HkdfSha256(), kdf: new HkdfSha256(), aead: new Chacha20Poly1305() });
    const raw = Uint8Array.from(atob(publicKeyBase64), (c) => c.charCodeAt(0));
    const recipientPublicKey = await suite.kem.deserializePublicKey(raw);
    const sender = await suite.createSenderContext({ recipientPublicKey, info: enc.encode("Pedestrian records lock v1") });
    const ct = new Uint8Array(await sender.seal(bytes, enc.encode(context)));
    const magic = enc.encode("PEDSEAL1"), ek = new Uint8Array(sender.enc);
    const out = new Uint8Array(magic.length + ek.length + ct.length);
    out.set(magic); out.set(ek, magic.length); out.set(ct, magic.length + ek.length);
    return out;
  }

  return { fillI9, fillW4, fillVA4, shopForm, sealFile };
}
