Point = Struct.new(:x, :y) do
  def norm = Math.sqrt(x**2 + y**2)
end

Segment = Data.define(:from, :to) do
  def length = from.distance_to(to)
end
