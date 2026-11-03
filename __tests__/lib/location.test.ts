import { displayJobType, isRemoteLocation, normalizeLocation } from "@/lib/location";

describe("normalizeLocation", () => {
  it("trims, collapses whitespace, and removes space before commas", () => {
    expect(normalizeLocation("  Austin   ,  TX ")).toBe("Austin, TX");
    expect(normalizeLocation("Paris   , France")).toBe("Paris, France");
    expect(normalizeLocation("San Jose,CA")).toBe("San Jose, CA");
    expect(normalizeLocation("\n\tRemote\n")).toBe("Remote");
  });

  it("returns an empty string for missing values", () => {
    expect(normalizeLocation(null)).toBe("");
    expect(normalizeLocation(undefined)).toBe("");
    expect(normalizeLocation("   ")).toBe("");
  });

  it("unifies the New York City spellings to New York, NY", () => {
    for (const input of [
      "New York City, New York",
      "New York, New York",
      "New York City, NY",
      "new york city , new york",
      "  New York  ,   New York ",
    ]) {
      expect(normalizeLocation(input)).toBe("New York, NY");
    }
  });

  it("does not rewrite New York in other contexts", () => {
    expect(normalizeLocation("New York")).toBe("New York");
    expect(normalizeLocation("New York City")).toBe("New York City");
    expect(normalizeLocation("New York City, Texas")).toBe("New York City, TX");
    expect(normalizeLocation("Albany, New York")).toBe("Albany, NY");
  });

  it("abbreviates City, FullStateName where unambiguous", () => {
    expect(normalizeLocation("San Francisco, California")).toBe("San Francisco, CA");
    expect(normalizeLocation("austin, texas")).toBe("austin, TX");
    expect(normalizeLocation("Seattle, Washington")).toBe("Seattle, WA");
    expect(normalizeLocation("Washington, District of Columbia")).toBe("Washington, DC");
    expect(normalizeLocation("Santa Fe, New Mexico")).toBe("Santa Fe, NM");
    expect(normalizeLocation("Charleston, West Virginia")).toBe("Charleston, WV");
  });

  it("keeps a trailing United States segment while abbreviating the state", () => {
    expect(normalizeLocation("Austin, Texas, United States")).toBe("Austin, TX, United States");
    expect(normalizeLocation("Austin , Texas , USA")).toBe("Austin, TX, USA");
  });

  it("leaves ambiguous or non-US locations alone", () => {
    expect(normalizeLocation("Tbilisi, Georgia")).toBe("Tbilisi, Georgia");
    expect(normalizeLocation("Atlanta, Georgia")).toBe("Atlanta, Georgia");
    expect(normalizeLocation("Atlanta, Georgia, United States")).toBe("Atlanta, GA, United States");
    expect(normalizeLocation("Sydney, New South Wales")).toBe("Sydney, New South Wales");
    expect(normalizeLocation("Toronto, Ontario, Canada")).toBe("Toronto, Ontario, Canada");
    expect(normalizeLocation("Austin, Texas, Remote")).toBe("Austin, Texas, Remote");
    expect(normalizeLocation("Paris, France")).toBe("Paris, France");
    expect(normalizeLocation("Texas")).toBe("Texas");
  });

  it("leaves already-abbreviated and remote values unchanged", () => {
    expect(normalizeLocation("San Francisco, CA")).toBe("San Francisco, CA");
    expect(normalizeLocation("Remote")).toBe("Remote");
    expect(normalizeLocation("Remote, United States")).toBe("Remote, United States");
  });

  it("is idempotent", () => {
    for (const input of ["New York City, New York", "Austin , Texas , USA", "Tbilisi,Georgia", "  x  "]) {
      const once = normalizeLocation(input);
      expect(normalizeLocation(once)).toBe(once);
    }
  });
});

describe("isRemoteLocation and displayJobType", () => {
  it("detects remote locations as whole words", () => {
    expect(isRemoteLocation("Remote")).toBe(true);
    expect(isRemoteLocation("United States (Remote)")).toBe(true);
    expect(isRemoteLocation("  remote - US ")).toBe(true);
    expect(isRemoteLocation("Remotely, somewhere")).toBe(false);
    expect(isRemoteLocation("Austin, TX")).toBe(false);
    expect(isRemoteLocation(null)).toBe(false);
  });

  it("keeps a stored job type and only fills an empty one from the location", () => {
    expect(displayJobType({ jobType: "Hybrid", location: "Remote" })).toBe("Hybrid");
    expect(displayJobType({ jobType: null, location: "Remote - US" })).toBe("Remote");
    expect(displayJobType({ jobType: "", location: "Remote" })).toBe("Remote");
    expect(displayJobType({ jobType: null, location: "Austin, TX" })).toBeNull();
    expect(displayJobType({ jobType: null, location: null })).toBeNull();
  });
});
