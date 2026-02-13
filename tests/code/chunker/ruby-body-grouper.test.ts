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
    // class is 'other', has_many is associations, validates is validations, end is dropped
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

    it("should classify aasm as state_machine", () => {
      expect(grouper.classifyLine("  aasm column: :status do")).toBe(
        "state_machine",
      );
    });

    it("should classify class_attribute and mattr_* as attributes", () => {
      expect(grouper.classifyLine("  class_attribute :api_key")).toBe(
        "attributes",
      );
      expect(
        grouper.classifyLine("  mattr_accessor :default_timeout"),
      ).toBe("attributes");
      expect(grouper.classifyLine("  mattr_reader :config")).toBe(
        "attributes",
      );
      expect(grouper.classifyLine("  mattr_writer :logger")).toBe(
        "attributes",
      );
      expect(
        grouper.classifyLine("  cattr_accessor :instance_count"),
      ).toBe("attributes");
      expect(grouper.classifyLine("  cattr_reader :pool")).toBe("attributes");
      expect(grouper.classifyLine("  cattr_writer :backend")).toBe(
        "attributes",
      );
    });
  });

  describe("block-aware body grouping", () => {
    // Plan test case 1: do...end scope body captured in scopes group
    it("should capture do...end scope body in the scopes group", () => {
      const lines = makeLines([
        "  scope :affected_by_time_entry, ->(time_entry) do",
        "    joins(:allocations)",
        "      .where('allocations.start_date <= ?', time_entry.date)",
        "      .distinct",
        "  end",
        "  scope :simple, -> { where(active: true) }",
      ]);
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("scopes");
      // All 6 lines (including do...end body) should be in one group
      expect(groups[0].lines).toHaveLength(6);
    });

    // Plan test case 2: multiline -> { } lambda captured
    it("should capture multiline -> { } lambda body", () => {
      const lines = makeLines([
        "  scope :active, -> {",
        "    where(active: true)",
        "      .where('deleted_at IS NULL')",
        "  }",
      ]);
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("scopes");
      expect(groups[0].lines).toHaveLength(4);
    });

    // Plan test case 3: nested { } (hash inside lambda) tracked correctly
    it("should handle nested { } inside lambda correctly", () => {
      const lines = makeLines([
        "  scope :with_status, ->(status) {",
        "    where(status: { in: status })",
        "      .order({ created_at: :desc })",
        "  }",
      ]);
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("scopes");
      expect(groups[0].lines).toHaveLength(4);
    });

    // Plan test case 4: `end` does NOT create separate "other" group
    it("should not create separate 'other' group for standalone end", () => {
      const lines = makeLines([
        "  scope :complex, ->(param) do",
        "    where(field: param)",
        "  end",
      ]);
      const groups = grouper.groupLines(lines);
      // end should be absorbed into the scope group, not create a separate "other" group
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("scopes");
      expect(groups[0].lines).toHaveLength(3);
    });

    // Plan test case 5: mix of do...end and inline { } scopes
    it("should handle mix of do...end and inline { } scopes", () => {
      const lines = makeLines([
        "  scope :complex, ->(param) do",
        "    joins(:items)",
        "      .where(active: true)",
        "  end",
        "  scope :simple, -> { where(draft: false) }",
        "  scope :another, ->(x) do",
        "    where(x: x)",
        "  end",
      ]);
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("scopes");
      expect(groups[0].lines).toHaveLength(8);
    });

    // Plan test case 6: aasm do...end with nested event do...end → one state_machine group
    it("should group aasm do...end with nested events as one state_machine group", () => {
      const lines = makeLines([
        "  aasm column: :status do",
        "    state :pending, initial: true",
        "    state :processing",
        "    state :completed",
        "",
        "    event :process do",
        "      transitions from: :pending, to: :processing",
        "    end",
        "",
        "    event :complete do",
        "      transitions from: :processing, to: :completed",
        "    end",
        "  end",
      ]);
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("state_machine");
      // All 13 lines should be in one group
      expect(groups[0].lines).toHaveLength(13);
    });

    // Plan test case 7: included do...end is transparent — content groups as flat body
    it("should treat included do...end as transparent — content groups normally", () => {
      const lines = makeLines([
        "  included do",
        "    include AASM",
        "",
        "    enum :status, { pending: 0, active: 1 }",
        "",
        "    validates :name, presence: true",
        "    validates :email, presence: true",
        "  end",
      ]);
      const groups = grouper.groupLines(lines);
      // included/end should be transparent, content should group by type:
      // includes (include AASM), enums (enum), validations (validates x2)
      const types = groups.map((g) => g.type);
      expect(types).toEqual(["includes", "enums", "validations"]);
    });

    // Plan test case 8: extended do...end is transparent
    it("should treat extended do...end as transparent — content groups normally", () => {
      const lines = makeLines([
        "  extended do",
        "    has_many :items",
        "    belongs_to :parent",
        "  end",
      ]);
      const groups = grouper.groupLines(lines);
      const types = groups.map((g) => g.type);
      expect(types).toEqual(["associations"]);
    });

    // Plan test case 9: class_attribute, mattr_accessor → "attributes" group
    it("should group class_attribute and mattr_accessor as attributes", () => {
      const lines = makeLines([
        "  class_attribute :api_key",
        "  mattr_accessor :default_timeout",
        "  cattr_accessor :instance_count",
      ]);
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("attributes");
      expect(groups[0].lines).toHaveLength(3);
    });

    // Plan test case 10: unknown identifiers (where, presence) → continuation
    it("should treat unknown identifiers as continuation", () => {
      const lines = makeLines([
        "  scope :active, ->(x) do",
        "    where(active: true)",
        "    presence(true)",
        "  end",
      ]);
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("scopes");
      expect(groups[0].lines).toHaveLength(4);
    });

    // Plan test case 11: callback after_commit do...end → body captured
    it("should capture after_commit do...end body in callbacks group", () => {
      const lines = makeLines([
        "  after_commit do",
        "    notify_subscribers",
        "    update_search_index",
        "  end",
      ]);
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("callbacks");
      expect(groups[0].lines).toHaveLength(4);
    });

    // Transparent block with nested do...end inside included do...end
    it("should handle nested do...end inside included do...end transparently", () => {
      const lines = makeLines([
        "  included do",
        "    aasm column: :status do",
        "      state :pending, initial: true",
        "      event :process do",
        "        transitions from: :pending, to: :processing",
        "      end",
        "    end",
        "    validates :name, presence: true",
        "  end",
      ]);
      const groups = grouper.groupLines(lines);
      const types = groups.map((g) => g.type);
      // aasm → state_machine (with nested event), validates → validations
      expect(types).toEqual(["state_machine", "validations"]);
    });

    // class_methods do...end is transparent
    it("should treat class_methods do...end as transparent", () => {
      const lines = makeLines([
        "  class_methods do",
        "    scope :active, -> { where(active: true) }",
        "    scope :recent, -> { order(created_at: :desc) }",
        "  end",
      ]);
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(1);
      expect(groups[0].type).toBe("scopes");
      expect(groups[0].lines).toHaveLength(2);
    });

    // splitOversizedGroups with mixed small and large groups
    it("should preserve small groups and split large ones with maxChunkSize", () => {
      const lines = makeLines([
        "  has_many :posts",
        "  has_many :comments",
        "",
        "  scope :s0, -> { where(field_0: true) }",
        "  scope :s1, -> { where(field_1: true) }",
        "  scope :s2, -> { where(field_2: true) }",
        "  scope :s3, -> { where(field_3: true) }",
        "  scope :s4, -> { where(field_4: true) }",
        "  scope :s5, -> { where(field_5: true) }",
        "  scope :s6, -> { where(field_6: true) }",
        "  scope :s7, -> { where(field_7: true) }",
        "  scope :s8, -> { where(field_8: true) }",
        "  scope :s9, -> { where(field_9: true) }",
      ]);
      // associations (~50 chars) should stay intact; scopes (~450 chars) may split
      const groups = grouper.groupLines(lines, 200);
      expect(groups[0].type).toBe("associations");
      expect(groups[0].lines).toHaveLength(2);
      // remaining groups are split scopes
      const scopeGroups = groups.filter((g) => g.type === "scopes");
      expect(scopeGroups.length).toBeGreaterThan(1);
    });

    // Plan test case 12: random DSL methods not in keywords → continuation
    it("should treat random DSL methods as continuation of current group", () => {
      const lines = makeLines([
        "  has_many :posts, dependent: :destroy",
        "  has_many :comments, through: :posts",
        "",
        "  scope :active, ->(x) do",
        "    joins(:stuff)",
        "    merge(OtherModel.active)",
        "  end",
      ]);
      const groups = grouper.groupLines(lines);
      expect(groups).toHaveLength(2);
      expect(groups[0].type).toBe("associations");
      expect(groups[1].type).toBe("scopes");
      // scope group: scope line + joins + merge + end = 4 lines
      expect(groups[1].lines).toHaveLength(4);
    });
  });
});
