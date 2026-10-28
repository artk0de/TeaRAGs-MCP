module Billing
  class InvoiceHandler
    class MissingAccountError < StandardError; end
    class InvalidAmountError < StandardError; end

    def initialize(account, amount)
      @account = account
      @amount = amount
    end

    def total = @amount * rate_for(@account)
    def label = "invoice-#{@account.id}"

    def call
      raise MissingAccountError, "no account given" unless @account
      raise InvalidAmountError, "amount must be positive" unless @amount.positive?
      @account.charge(total)
    end

    private

    def rate_for(account) = account.premium? ? 0.9 : 1.0
  end
end
