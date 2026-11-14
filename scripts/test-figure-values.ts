/**
 * Pure tests for lib/integrations/figure-values.ts: the subject-led option
 * parser, the tolerant count-label matcher, the option-name gate and the
 * subject-less title rule. No database. Prints "figure-values ok" or the list of
 * failures and exits non-zero.
 */
import {
  isFigureCountLabel,
  isSubjectOptionName,
  mentionsFiguresInNote,
  mentionsFigureWords,
  mentionsPeopleOrPets,
  parseCountOptionValue,
  parseSubjectLed,
  parseSubjectLedCount,
  readCountFromVariations,
  titleNamesSingleSubject,
} from "../lib/integrations/figure-values";

const failures: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    failures.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  }
}

// ---- parseSubjectLedCount: the exact examples from the brief ----------------
const led: [string | null | undefined, number | null][] = [
  ["House (With Yard)", 1],
  ["House Only", 1],
  ["House & 4 Figure/pet", 5],
  ["House & 3 Figure/pet", 4],
  ["House &amp; 4 Figure/pet", 5], // Etsy sometimes hands the ampersand HTML-escaped
  ["Venue Only", 1],
  ["Venue +2 people/pets", 3],
  ["Venue + 2 People/Pets", 3],
  ["Car Only", 1],
  ["2 Houses", 2],
  ["Two Houses", 2],
  ["Home Only", 1],
  ["Church Only", 1],
  ["House with 1 pet", 2],
  ["House & 2 Figure/pet (+$15.00)", 3], // a price fragment is not a count
  ["House (With Yard) (+A$20)", 1],
  ["House & 2 people or pets", 3], // alternates for one thing, counted once
  // nothing clear: never guess
  ["Add Background", null],
  ["2 Figures+Background", null], // figures but no subject: the count-label reader owns this
  ["8x10", null],
  ["", null],
  [null, null],
  [undefined, null],
  ["House + pets", null], // figures with no number
  ["House 2", null], // a number that counts nothing we know
  ["House & 25 pets", null], // beyond the ceiling
  ["Digital Download", null],
  ["Yes", null],
  ["Pets only", null],
];
for (const [value, want] of led) eq(`parseSubjectLedCount(${JSON.stringify(value)})`, parseSubjectLedCount(value), want);

const detail = parseSubjectLed("House & 4 Figure/pet");
eq("parseSubjectLed detail", detail, { count: 5, subjects: 1, added: 4 });

// ---- parseCountOptionValue: the value of an option whose NAME is a count ----
const counts: [string | null | undefined, number | null][] = [
  ["2", 2],
  ["1", 1],
  ["Two", 2],
  ["3 pets", 3],
  ["2 Figures+Background", 2],
  ["House Only", 1],
  ["Venue +2 people/pets", 3],
  ["Add Background", null],
  ["House + pets", null], // a subject word the strict reading refused: no stray digit
  ["0", null],
  ["", null],
  [null, null],
];
for (const [value, want] of counts) eq(`parseCountOptionValue(${JSON.stringify(value)})`, parseCountOptionValue(value), want);

// ---- isFigureCountLabel: tolerant on case and punctuation -------------------
const labelYes = [
  "Number Of People/Pets",
  "Number Of Figures/Pets",
  "Number of Pets:",
  "NUMBER OF PEOPLE",
  "number-of-figures",
  "Number Of Figures",
  "Number of Persons",
  "Number of Faces",
  "Number of Subjects",
  "Figures",
  "No. of characters (houses, people, pets, etc)",
  "No. of characters (venues, people, pets, etc)",
  "How many pets?",
];
const labelNo = [
  "Add Background",
  "Background",
  "Size",
  "Print Size",
  "Rush Fee (12-24 Hours Digital Delivery)",
  "Personalization",
  "Options",
  "Drawing Options",
  "Frame",
  "Paper Type",
  "Number of Prints",
  "Number of Copies",
  "Number of Names",
  "Colour",
  "Font",
  "",
];
for (const name of labelYes) eq(`isFigureCountLabel(${JSON.stringify(name)})`, isFigureCountLabel(name), true);
for (const name of labelNo) eq(`isFigureCountLabel(${JSON.stringify(name)})`, isFigureCountLabel(name), false);
eq("isFigureCountLabel(null)", isFigureCountLabel(null), false);

// ---- isSubjectOptionName: which option names may carry the subject ----------
const nameYes = ["Options", "Option", "Drawing Options", "Characters", "Type", "Figures/Pets"];
const nameNo = [
  "Background",
  "Add Background",
  "Size",
  "Print Options",
  "Frame Options",
  "Paper Options",
  "Colour Options",
  "Font Options",
  "Shipping Options",
  "Delivery Options",
  "Rush Fee (12-24 Hours Digital Delivery)",
  "Personalization",
  "",
];
for (const name of nameYes) eq(`isSubjectOptionName(${JSON.stringify(name)})`, isSubjectOptionName(name), true);
for (const name of nameNo) eq(`isSubjectOptionName(${JSON.stringify(name)})`, isSubjectOptionName(name), false);

// ---- readCountFromVariations: whole-item readings ---------------------------
const rush = { name: "Rush Fee (12-24 Hours Digital Delivery)", value: "No" };
eq(
  "reading: Options = House (With Yard)",
  readCountFromVariations([{ name: "Options", value: "House (With Yard)" }, rush]),
  { status: "count", count: 1, agrees: [], note: 'option "Options: House (With Yard)" names 1 subject' },
);
const drawing = readCountFromVariations([{ name: "Drawing Options", value: "House (With Yard)" }, rush]);
eq("reading: Drawing Options = House (With Yard)", drawing.status === "count" ? drawing.count : drawing, 1);
const houseFigures = readCountFromVariations([{ name: "Options", value: "House & 4 Figure/pet" }]);
eq("reading: House & 4 Figure/pet", houseFigures.status === "count" ? [houseFigures.count, houseFigures.agrees] : houseFigures, [5, [4]]);
const venue = readCountFromVariations([{ name: "No. of characters (venues, people, pets, etc)", value: "Venue +2 people/pets" }]);
eq("reading: venue +2", venue.status === "count" ? venue.count : venue, 3);
const people = readCountFromVariations([{ name: "Number Of People/Pets", value: "2 Figures+Background" }]);
eq("reading: Number Of People/Pets = 2 Figures+Background", people.status === "count" ? people.count : people, 2);
eq(
  "reading: Number Of Figures/Pets = Add Background is ambiguous",
  readCountFromVariations([{ name: "Number Of Figures/Pets", value: "Add Background" }]).status,
  "ambiguous",
);
eq(
  "reading: Options = Family Portrait is ambiguous",
  readCountFromVariations([{ name: "Options", value: "Family Portrait" }]).status,
  "ambiguous",
);
eq("reading: Size only is none", readCountFromVariations([{ name: "Size", value: "8x10" }]).status, "none");
eq("reading: Options = Digital Download is none", readCountFromVariations([{ name: "Options", value: "Digital Download" }]).status, "none");
eq("reading: empty is none", readCountFromVariations([]).status, "none");
eq(
  "reading: a Background option never carries the subject",
  readCountFromVariations([{ name: "Background", value: "House Only" }]).status,
  "none",
);
eq(
  "reading: two options that disagree are ambiguous",
  readCountFromVariations([
    { name: "Options", value: "House & 4 Figure/pet" },
    { name: "Number Of Pets", value: "2" },
  ]).status,
  "ambiguous",
);
const agree = readCountFromVariations([
  { name: "Options", value: "House (With Yard)" },
  { name: "No. of characters", value: "1" },
]);
eq("reading: two options that agree", agree.status === "count" ? agree.count : agree, 1);

// ---- titles ------------------------------------------------------------------
const titleYes = [
  "Minimalist Watercolour Sketch of Your Home",
  "Custom Watercolor House Portrait",
  "Personalized Car Drawing",
  "Custom Home Portrait Watercolor",
  "Watercolor House Painting From Photo",
  "Custom Venue Illustration",
  "Personalised Vehicle Drawing",
];
const titleNo = [
  "Custom Family Portrait with House",
  "Watercolor House Portrait with Pets",
  "Pet Portrait",
  "Couple Portrait",
  "Custom Watercolor Portrait",
  "House and Dog Portrait",
  "Wedding Venue Portrait with Bride and Groom",
  "Watercolor House Portrait with Your Family",
  "",
];
for (const title of titleYes) eq(`titleNamesSingleSubject(${JSON.stringify(title)})`, titleNamesSingleSubject(title), true);
for (const title of titleNo) eq(`titleNamesSingleSubject(${JSON.stringify(title)})`, titleNamesSingleSubject(title), false);
eq("titleNamesSingleSubject(null)", titleNamesSingleSubject(null), false);

// ---- people and pet words ----------------------------------------------------
eq("mentionsPeopleOrPets: pets", mentionsPeopleOrPets("House portrait with our pets"), true);
eq("mentionsPeopleOrPets: plain", mentionsPeopleOrPets("Custom house portrait"), false);
eq("mentionsFigureWords: Venue Only", mentionsFigureWords("Venue Only"), true);
eq("mentionsFigureWords: Digital Download", mentionsFigureWords("Digital Download"), false);

// Buyer free text: only people and pet nouns block a title guess. A gift note
// or a family surname phrase does not.
eq("mentionsFiguresInNote: dog", mentionsFiguresInNote("please add our dog Max"), true);
eq("mentionsFiguresInNote: people", mentionsFiguresInNote("two people on the porch"), true);
eq("mentionsFiguresInNote: gift for mum", mentionsFiguresInNote("This is a gift for my mum"), false);
eq("mentionsFiguresInNote: The Owen Family Home", mentionsFiguresInNote("The Owen Family Home \n17 Lochend Cct. East Maitland"), false);
eq("mentionsFiguresInNote: year and street number", mentionsFiguresInNote("1. Our Forever Home \nestablished 2020"), false);
eq("mentionsFiguresInNote: null", mentionsFiguresInNote(null), false);

if (failures.length) {
  console.error(`figure-values FAILED (${failures.length}):\n` + failures.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("figure-values ok");
