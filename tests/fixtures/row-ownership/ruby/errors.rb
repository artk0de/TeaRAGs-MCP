module Payments
  class GatewayClient
    class ConnectionRefusedByGatewayError < StandardError; end
    class AuthenticationRejectedByGatewayError < StandardError; end
    class UnexpectedGatewayResponseFormatError < StandardError; end

    def endpoint_url = "#{configuration.base_url}/v2/payments/#{merchant_id}"
    def authorization_header = { "Authorization" => "Bearer #{configuration.api_token}" }
    def request_timeout_seconds = configuration.timeout_seconds || DEFAULT_TIMEOUT

    def submit(payload)
      response = http.post(endpoint_url, payload.to_json, authorization_header)
      raise UnexpectedGatewayResponseFormatError unless response.body.start_with?("{")
      JSON.parse(response.body)
    end
  end
end
