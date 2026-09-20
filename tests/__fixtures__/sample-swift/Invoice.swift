import Foundation

/// A line item billed on an invoice.
public struct InvoiceLine {
    public let description: String
    public var quantity: Int
    public var unitPrice: Decimal

    public init(description: String, quantity: Int, unitPrice: Decimal) {
        self.description = description
        self.quantity = quantity
        self.unitPrice = unitPrice
    }

    public mutating func scale(by factor: Int) {
        quantity *= factor
    }

    public var total: Decimal {
        return Decimal(quantity) * unitPrice
    }
}

public enum InvoiceState: String {
    case draft
    case sent
    case paid

    public var isFinal: Bool {
        return self == .paid
    }

    public func transition(to next: InvoiceState) -> InvoiceState {
        return next
    }
}

public class Invoice {
    public static let defaultTerms: Int = 30
    private var lines: [InvoiceLine] = []
    public private(set) var number: String
    public var state: InvoiceState = .draft

    public init(number: String) {
        self.number = number
        state = .draft
    }

    public convenience init() {
        self.init(number: "INV-0001")
    }

    public func add(_ line: InvoiceLine) {
        lines.append(line)
    }

    public func total() -> Decimal {
        return lines.reduce(Decimal.zero) { $0 + $1.total }
    }

    public static func empty() -> Invoice {
        return Invoice()
    }
}

extension Invoice {
    public func totalsByQuantity() -> [Int: Decimal] {
        var out: [Int: Decimal] = [:]
        for line in lines {
            out[line.quantity, default: .zero] += line.total
        }
        return out
    }
}
