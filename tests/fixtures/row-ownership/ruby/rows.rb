module Reports
  Row = Struct.new(:name, :count) do
    def to_s = name
  end

  Cell = Data.define(:x, :y) do
    def sum = x + y
  end

  class Summary
    Line = Struct.new(:title, :total, keyword_init: true) do
      def blank? = total.zero?
    end

    def initialize(lines)
      @lines = lines.map { |l| Line.new(**l) }
    end

    def grand_total
      @lines.sum(&:total)
    end
  end
end
