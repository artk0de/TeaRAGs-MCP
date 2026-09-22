import Nimble
import Quick

@testable import Billing

final class InvoiceSpec: QuickSpec {
    override class func spec() {
        var invoice: Invoice!

        beforeEach {
            invoice = Invoice(number: "INV-1", total: 100)
        }

        describe("Invoice") {
            context("when overdue") {
                beforeEach {
                    invoice.dueDate = Date.distantPast
                }

                it("adds a late penalty to the total") {
                    expect(invoice.total).to(equal(110))
                }

                it("reports itself as late") {
                    expect(invoice.isLate).to(beTrue())
                }
            }

            context("when paid") {
                beforeEach {
                    invoice.state = .paid
                }

                it("keeps the total unchanged") {
                    expect(invoice.total).to(equal(100))
                }
            }

            it("starts life as a draft") {
                expect(invoice.state).to(equal(.draft))
            }
        }

        describe("InvoiceLine") {
            it("multiplies quantity by unit price") {
                let line = InvoiceLine(quantity: 3, unitPrice: 7)
                expect(line.total).to(equal(21))
            }
        }
    }

    private static func makeInvoice(total: Decimal) -> Invoice {
        return Invoice(number: "INV-TEST", total: total)
    }
}
