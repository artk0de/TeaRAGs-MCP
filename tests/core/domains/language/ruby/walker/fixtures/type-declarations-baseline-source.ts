/**
 * A Ruby file exercising every channel the walker publishes alongside
 * `typeDeclarations` — requires, Zeitwerk refs, nested and compact
 * declarations, heritage, a dispatch table, constants, DSL accessors and calls.
 * `type-declarations-baseline.json` is this file's extraction as the walker
 * produced it BEFORE it published `typeDeclarations` (bd tea-rags-mcp-vi0wx,
 * W3c); the type-declaration test pins that the new channel changed nothing
 * else.
 */
export const BASELINE_RUBY_SOURCE = [
  "require 'json'",
  "require_relative './support/base'",
  "",
  "VERSION = '1.0'",
  "Acme::Config::TIMEOUT = 30",
  "",
  "module Acme",
  "  module Auth",
  "    MAX = 3",
  "    HANDLERS = { login: :handle_login, logout: :handle_logout }.freeze",
  "",
  "    class Login < Base",
  "      include Trackable",
  "      prepend Instrumented",
  "      extend Finders",
  "      attr_reader :user",
  "",
  "      class << self",
  "        def build(params)",
  "          new(params).tap(&:validate)",
  "        end",
  "      end",
  "",
  "      def initialize(params)",
  "        @user = User.find(params[:id])",
  "        limit = MAX",
  "        Audit.record(limit)",
  "      end",
  "",
  "      def dispatch(kind)",
  "        send(HANDLERS.fetch(kind))",
  "      end",
  "    end",
  "  end",
  "",
  "  class Auth::Session < Acme::Record",
  "    def expire!",
  "      update(expired: true)",
  "    end",
  "  end",
  "end",
  "",
].join("\n");
