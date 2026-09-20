import Foundation

public protocol LedgerExporting {
    func export(_ ledger: Ledger) -> Data
    static func supports(_ format: String) -> Bool
}

public class Ledger {
    public class Account {
        public let name: String
        public private(set) var balance: Decimal

        public init(name: String, balance: Decimal) {
            self.name = name
            self.balance = balance
        }

        public func post(_ amount: Decimal) {
            balance += amount
        }

        public static func opening(_ name: String) -> Account {
            return Account(name: name, balance: .zero)
        }
    }

    private var accounts: [String: Account] = [:]

    public init() {}

    public func open(_ name: String) -> Account {
        let account = Account.opening(name)
        accounts[name] = account
        return account
    }

    public func balance(of name: String) -> Decimal {
        return accounts[name]?.balance ?? .zero
    }

    public func balance(of name: String, in currency: String) -> Decimal {
        return balance(of: name)
    }
}

public struct CsvExporter: LedgerExporting {
    public init() {}

    public func export(_ ledger: Ledger) -> Data {
        return Data("csv".utf8)
    }

    public static func supports(_ format: String) -> Bool {
        return format == "csv"
    }
}

public func formatDecimal(_ value: Decimal) -> String {
    return "\(value)"
}
