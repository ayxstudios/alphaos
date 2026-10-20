// Pure checks for the PixArt Disney-people filter (lib/orders/disney-people.ts).
import assert from "node:assert/strict";
import { peopleMention } from "../lib/orders/disney-people";

const P = (value: string) => ({ options: [{ name: "Personalization", value }] });
const yes: [string, object][] = [
  ["human girl", P("English Springer Spaniel - Sadie, Girl\nhuman girl - Jordyn\nhuman guy - Griffin")],
  ["Persons name", P("1. Pet name : Shiva, Persons name : Nando 2. Background: stripes")],
  ["me and", P("Can you draw me and my dog Bella together?")],
  ["with my husband", P("Please draw Max with my husband")],
  ["husband and our dog", P("My husband and our dog Rex on the couch")],
  ["family portrait", P("Family portrait with our 2 cats")],
  ["customer note", { notes: "Customer note (2026-10-20): please add myself holding him" }],
  ["chat words", { notes: "Photos came in through the buyer's Etsy chat, not the order form, so they are not labelled by person or pet: check the chat if unsure who is who. Her own words: it's me holding Luna in photo 2, include me please" }],
  ["etsy note", { messageFromBuyer: "Could you include my daughter next to the cat?" }],
];
const no: [string, object][] = [
  ["pet gender", P("1. Riley\n2. Female")],
  ["a girl pet", P("The pets name is Lily, she is a girl")],
  ["gift for mom", P("1. ivy \n2. girl\n3. she passed away, a gift for my mom. if you could add wings or a halo")],
  ["leave out", P("no birthday hat or party items, and leave out the person in photo 5")],
  ["no people", P("Just the dog please, no people")],
  ["boilerplate only", { notes: "Photos came in through the buyer's Etsy chat, not the order form, so they are not labelled by person or pet: check the chat if unsure who is who. Her own words: Bella is the brown one" }],
  ["agent note", { notes: "Added 2026-10-19: Human designer Wahyu retains the correction." }],
  ["the boy pet", P("Would it be possible to give the boy a bandana and the girls a neck bow?")],
  ["background option", { options: [{ name: "Background", value: "Family photo style" }] }],
];
for (const [label, src] of yes) assert.ok(peopleMention(src as never), `should flag: ${label}`);
for (const [label, src] of no) assert.equal(peopleMention(src as never), null, `should not flag: ${label}`);
console.log(`disney-people: ${yes.length + no.length} checks passed`);
