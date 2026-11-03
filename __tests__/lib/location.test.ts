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

  it("unifies the bare New York area names to New York, NY", () => {
    for (const input of [
      "New York",
      "new york",
      "New York City",
      "NYC",
      "New York Metropolitan Area",
      "New York City Metropolitan Area",
      "Greater New York City Area",
    ]) {
      expect(normalizeLocation(input)).toBe("New York, NY");
    }
  });

  it("does not rewrite New York in other contexts", () => {
    expect(normalizeLocation("Manhattan, NY")).toBe("Manhattan, NY");
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

  it("cleans values scraped from job boards", () => {
    expect(normalizeLocation("remote")).toBe("Remote");
    expect(normalizeLocation("REMOTE")).toBe("Remote");
    expect(normalizeLocation("Remote Software Engineer (US)")).toBe("Remote");
    expect(normalizeLocation("Remote Developer")).toBe("Remote");
    expect(normalizeLocation("Available in 48 locations See allSee all")).toBe("Multiple Locations");
    expect(normalizeLocation("San Francisco, CA, USA, N/A")).toBe("San Francisco, CA, USA");
    expect(normalizeLocation("n/a")).toBe("");
  });

  it("cleans each location in a semicolon-separated list", () => {
    expect(normalizeLocation("New York, NY ; San Francisco, California")).toBe(
      "New York, NY; San Francisco, CA",
    );
    expect(normalizeLocation("New York, New York; Santa Monica, California")).toBe(
      "New York, NY; Santa Monica, CA",
    );
    expect(normalizeLocation("Austin, Texas;")).toBe("Austin, TX");
    expect(normalizeLocation(" ; n/a ; ")).toBe("");
  });

  it("does not split other multi-location text", () => {
    expect(normalizeLocation("Mountain View, California San Francisco, California")).toBe(
      "Mountain View, California San Francisco, California",
    );
  });

  it("keeps remote values that carry a region", () => {
    expect(normalizeLocation("Remote - USA")).toBe("Remote - USA");
    expect(normalizeLocation("US Remote")).toBe("US Remote");
    expect(normalizeLocation("US (remote), Boston (hybrid) or New York (Hybrid)")).toBe(
      "US (remote), Boston (hybrid) or New York (Hybrid)",
    );
  });

  it("is idempotent", () => {
    for (const input of [
      "New York City, New York",
      "Austin , Texas , USA",
      "Tbilisi,Georgia",
      "  x  ",
      "New York City Metropolitan Area",
      "Remote Software Engineer (US)",
      "Available in 48 locations See allSee all",
      "San Francisco, CA, USA, N/A",
      "New York, NY ; San Francisco, California",
    ]) {
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
