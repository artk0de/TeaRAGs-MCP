import { describe, it, expect } from "vitest";
import {
  RubyBodyGrouper,
  type BodyGroup,
  type BodyLine,
} from "../../../src/code/chunker/ruby-body-grouper.js";

describe("RubyBodyGrouper", () => {
  const grouper = new RubyBodyGrouper();

  /** Helper: create BodyLine[] from text lines with sequential source lines */
  function makeLines(texts: string[], startSourceLine = 1): BodyLine[] {
    return texts.map((text, i) => ({
      text,
      sourceLine: startSourceLine + i,
    }));
  }

  it("should group associations together", () => {
    const lines = makeLines([
      "  has_many :posts, dependent: :destroy",
      "  has_many :comments, dependent: :destroy",
      "  belongs_to :organization",
    ]);
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("associations");
    expect(groups[0].lines).toHaveLength(3);
  });

  it("should split different declaration types into separate groups", () => {
    const lines = makeLines([
      "  has_many :posts",
      "  has_many :comments",
      "",
      "  validates :email, presence: true",
      "  validates :name, presence: true",
      "",
      "  scope :active, -> { where(active: true) }",
      "  scope :recent, -> { order(created_at: :desc) }",
    ]);
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe("associations");
    expect(groups[1].type).toBe("validations");
    expect(groups[2].type).toBe("scopes");
  });

  it("should handle includes and extends", () => {
    const lines = makeLines([
      "  include AASM",
      "  include Searchable",
      "  extend ClassMethods",
    ]);
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("includes");
  });

  it("should handle callbacks", () => {
    const lines = makeLines([
      "  before_save :normalize_email",
      "  after_create :send_welcome",
      "  before_validation :strip_whitespace",
    ]);
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("callbacks");
  });

  it("should group unknown declarations as 'other'", () => {
    const lines = makeLines(["  CONSTANT = 42", "  TABLE_NAME = 'users'"]);
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("other");
  });

  it("should keep blank-line-separated same-type groups merged", () => {
    const lines = makeLines([
      "  has_many :posts",
      "",
      "  has_many :comments",
    ]);
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("associations");
  });

  it("should split oversized groups by maxChunkSize", () => {
    const texts: string[] = [];
    for (let i = 0; i < 100; i++) {
      texts.push(`  scope :scope_${i}, -> { where(field_${i}: true) }`);
    }
    const lines = makeLines(texts);
    const groups = grouper.groupLines(lines, 500);
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.type).toBe("scopes");
    }
  });

  it("should handle mixed declarations in realistic model", () => {
    const lines = makeLines([
      "  include AASM",
      "  include Avatar",
      "",
      "  has_many :posts, dependent: :destroy",
      "  has_many :comments, dependent: :destroy",
      "  belongs_to :organization",
      "",
      "  enum :role, { admin: 0, user: 1, guest: 2 }",
      "",
      "  validates :email, presence: true, uniqueness: true",
      "  validates :name, length: { maximum: 255 }",
      "  validate :custom_validation",
      "",
      "  before_save :normalize_email",
      "  after_create :send_welcome_email",
      "",
      "  scope :active, -> { where(active: true) }",
      "  scope :admins, -> { where(role: :admin) }",
      "",
      "  delegate :name, to: :organization, prefix: true",
    ]);
    const groups = grouper.groupLines(lines);
    const types = groups.map((g) => g.type);
    expect(types).toEqual([
      "includes",
      "associations",
      "enums",
      "validations",
      "callbacks",
      "scopes",
      "delegates",
    ]);
  });

  it("should handle multiline declarations (scope with block)", () => {
    const lines = makeLines([
      "  scope :complex, lambda {",
      "    where(active: true)",
      "      .where('created_at > ?', 1.week.ago)",
      "      .order(created_at: :desc)",
      "  }",
      "  scope :simple, -> { where(draft: false) }",
    ]);
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("scopes");
    expect(groups[0].lines).toHaveLength(6);
  });

  it("should skip blank-only lines and preserve them as separators", () => {
    const lines = makeLines([
      "",
      "  has_many :posts",
      "",
      "",
      "  validates :email",
      "",
    ]);
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(2);
    expect(groups[0].type).toBe("associations");
    expect(groups[1].type).toBe("validations");
  });

  it("should handle class/end lines gracefully", () => {
    const lines = makeLines([
      "class User < ApplicationRecord",
      "  has_many :posts",
      "  validates :email",
      "end",
    ]);
    const groups = grouper.groupLines(lines);
    // class/end are 'other', has_many is associations, validates is validations
    expect(groups.length).toBeGreaterThanOrEqual(2);
  });

  describe("BodyLine interface and line ranges", () => {
    it("should preserve sourceLine in output BodyLine objects", () => {
      const lines: BodyLine[] = [
        { text: "  has_many :posts", sourceLine: 5 },
        { text: "  has_many :comments", sourceLine: 6 },
        { text: "  belongs_to :org", sourceLine: 7 },
      ];
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].lines[0].sourceLine).toBe(5);
      expect(groups[0].lines[1].sourceLine).toBe(6);
      expect(groups[0].lines[2].sourceLine).toBe(7);
    });

    it("should compute contiguous lineRanges for consecutive source lines", () => {
      const lines: BodyLine[] = [
        { text: "  has_many :posts", sourceLine: 3 },
        { text: "  has_many :comments", sourceLine: 4 },
        { text: "  belongs_to :org", sourceLine: 5 },
      ];
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].lineRanges).toEqual([{ start: 3, end: 5 }]);
    });

    it("should compute non-contiguous lineRanges when source lines have gaps", () => {
      const lines: BodyLine[] = [
        { text: "  has_many :posts", sourceLine: 3 },
        { text: "  has_many :comments", sourceLine: 4 },
        { text: "  belongs_to :org", sourceLine: 5 },
        { text: "  has_one :profile", sourceLine: 10 },
        { text: "  has_one :avatar", sourceLine: 11 },
      ];
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].lineRanges).toEqual([
        { start: 3, end: 5 },
        { start: 10, end: 11 },
      ]);
    });

    it("should compute lineRanges per group with non-contiguous lines across groups", () => {
      const lines: BodyLine[] = [
        { text: "  has_many :posts", sourceLine: 3 },
        { text: "  has_many :comments", sourceLine: 4 },
        { text: "", sourceLine: 5 },
        { text: "  validates :email", sourceLine: 10 },
        { text: "  validates :name", sourceLine: 11 },
      ];
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(2);
      expect(groups[0].type).toBe("associations");
      expect(groups[0].lineRanges).toEqual([{ start: 3, end: 4 }]);
      expect(groups[1].type).toBe("validations");
      expect(groups[1].lineRanges).toEqual([{ start: 10, end: 11 }]);
    });

    it("should handle blank lines absorbed into same-type group with gaps in lineRanges", () => {
      const lines: BodyLine[] = [
        { text: "  has_many :posts", sourceLine: 3 },
        { text: "", sourceLine: 4 },
        { text: "  has_many :comments", sourceLine: 5 },
      ];
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("associations");
      // Blank line is absorbed but included in lines array (as pending blank)
      expect(groups[0].lines).toHaveLength(3);
      expect(groups[0].lines[0].sourceLine).toBe(3);
      expect(groups[0].lines[2].sourceLine).toBe(5);
    });

    it("should handle single-line groups with correct lineRanges", () => {
      const lines: BodyLine[] = [
        {
          text: "  enum :status, { active: 0, inactive: 1 }",
          sourceLine: 15,
        },
      ];
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].lineRanges).toEqual([{ start: 15, end: 15 }]);
    });
  });

  describe("multiline declaration handling", () => {
    it("should keep multiline scope block as continuation lines in the same group", () => {
      const lines = makeLines(
        [
          "  scope :complex, lambda {",
          "    where(active: true)",
          "      .where('created_at > ?', 1.week.ago)",
          "  }",
          "  scope :simple, -> { where(draft: false) }",
        ],
        10,
      );
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("scopes");
      expect(groups[0].lines).toHaveLength(5);
      expect(groups[0].lineRanges).toEqual([{ start: 10, end: 14 }]);
    });

    it("should handle multiline validation block", () => {
      const lines = makeLines(
        [
          "  validates :email,",
          "    presence: true,",
          "    uniqueness: { case_sensitive: false }",
          "  validates :name, presence: true",
        ],
        20,
      );
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("validations");
      expect(groups[0].lines).toHaveLength(4);
      expect(groups[0].lineRanges).toEqual([{ start: 20, end: 23 }]);
    });
  });

  describe("classifyLine", () => {
    it("should classify association keywords", () => {
      expect(grouper.classifyLine("  has_many :posts")).toBe("associations");
      expect(grouper.classifyLine("  has_one :profile")).toBe("associations");
      expect(grouper.classifyLine("  belongs_to :user")).toBe("associations");
      expect(grouper.classifyLine("  has_and_belongs_to_many :tags")).toBe(
        "associations",
      );
    });

    it("should classify validation keywords", () => {
      expect(grouper.classifyLine("  validates :email")).toBe("validations");
      expect(grouper.classifyLine("  validate :custom")).toBe("validations");
      expect(grouper.classifyLine("  validates_presence_of :name")).toBe(
        "validations",
      );
      expect(grouper.classifyLine("  validates_uniqueness_of :email")).toBe(
        "validations",
      );
    });

    it("should classify scope keyword", () => {
      expect(
        grouper.classifyLine("  scope :active, -> { where(active: true) }"),
      ).toBe("scopes");
    });

    it("should classify callback keywords", () => {
      expect(grouper.classifyLine("  before_save :normalize")).toBe(
        "callbacks",
      );
      expect(grouper.classifyLine("  after_create :notify")).toBe("callbacks");
      expect(grouper.classifyLine("  around_save :wrap")).toBe("callbacks");
      expect(grouper.classifyLine("  after_commit :sync")).toBe("callbacks");
      expect(grouper.classifyLine("  before_action :auth")).toBe("callbacks");
      expect(grouper.classifyLine("  skip_before_action :auth")).toBe(
        "callbacks",
      );
    });

    it("should classify include/extend/prepend keywords", () => {
      expect(grouper.classifyLine("  include AASM")).toBe("includes");
      expect(grouper.classifyLine("  extend ClassMethods")).toBe("includes");
      expect(grouper.classifyLine("  prepend Overrides")).toBe("includes");
    });

    it("should classify attribute keywords", () => {
      expect(grouper.classifyLine("  attr_accessor :name")).toBe("attributes");
      expect(grouper.classifyLine("  attr_reader :id")).toBe("attributes");
      expect(grouper.classifyLine("  attribute :status")).toBe("attributes");
      expect(grouper.classifyLine("  has_one_attached :avatar")).toBe(
        "attributes",
      );
      expect(grouper.classifyLine("  has_many_attached :photos")).toBe(
        "attributes",
      );
    });

    it("should classify delegate keywords", () => {
      expect(grouper.classifyLine("  delegate :name, to: :user")).toBe(
        "delegates",
      );
      expect(grouper.classifyLine("  delegate_missing_to :base")).toBe(
        "delegates",
      );
    });

    it("should classify enum keyword", () => {
      expect(grouper.classifyLine("  enum :status, { active: 0 }")).toBe(
        "enums",
      );
    });

    it("should classify nested attributes", () => {
      expect(
        grouper.classifyLine("  accepts_nested_attributes_for :addresses"),
      ).toBe("nested_attrs");
    });

    it("should return undefined for blank lines", () => {
      expect(grouper.classifyLine("")).toBeUndefined();
      expect(grouper.classifyLine("   ")).toBeUndefined();
    });

    it("should return 'other' for unrecognized identifiers", () => {
      expect(grouper.classifyLine("  CONSTANT = 42")).toBe("other");
      expect(grouper.classifyLine("  self.table_name = 'users'")).toBe(
        "other",
      );
    });

    it("should return undefined for non-identifier lines", () => {
      expect(grouper.classifyLine("  # comment")).toBeUndefined();
      expect(grouper.classifyLine("  }")).toBeUndefined();
    });
  });
});
