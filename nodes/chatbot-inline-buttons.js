const MessageTemplate = require("../lib/message-template-async");
const emoji = require("node-emoji");
const { ChatExpress } = require("chat-platform-bildi");

const RegisterType = require("../lib/node-installer");
const {
  isValidMessage,
  getChatId,
  getMessageId,
  extractValue,
  appendPayload,
  getTransport,
} = require("../lib/helpers/utils");
const GlobalContextHelper = require("../lib/helpers/global-context-helper");

module.exports = function(RED) {
  const registerType = RegisterType(RED);
  const globalContextHelper = GlobalContextHelper(RED);

  function ChatBotInlineButtons(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    globalContextHelper.init(this.context().global);
    this.name = config.name;
    this.buttons = config.buttons;
    this.message = config.message;
    this.trackMessage = config.trackMessage;

    this.relay = function(msg) {
      // copy msg in the right position
      const toSend = node.buttons.map(({ value }) =>
        msg.payload?.content === value ? msg : null
      );
      // first pin is alway to sender
      toSend.unshift(null);
      node.send(toSend);
    };

    this.on("input", function(msg, send, done) {
      // send/done compatibility for node-red < 1.0
      send =
        send ||
        function() {
          node.send.apply(node, arguments);
        };
      done =
        done ||
        function(error) {
          node.error.call(node, error, msg);
        };
      const sendPayload = appendPayload(send, msg);
      const transport = getTransport(msg);

      // check if valid message
      if (!isValidMessage(msg, node)) {
        return;
      }
      // check transport compatibility
      if (!ChatExpress.isSupported(transport, "inline-buttons")) {
        return;
      }

      const chatId = getChatId(msg);
      const messageId = getMessageId(msg);
      const template = MessageTemplate(msg, node);

      // prepare buttons, first the config, then payload
      const buttons = extractValue("buttons", "buttons", node, msg);
      const message = extractValue("string", "message", node, msg);
      const name = extractValue("string", "name", node, msg);

      template(message, buttons).then(([message, buttons]) => {
        sendPayload({
          type: "inline-buttons",
          name,
          content: message != null ? emoji.emojify(message) : null,
          chatId,
          messageId,
          buttons,
          trackNodeId: node.trackMessage ? node._path : undefined,
        });
        done();
      });
    });
  }

  registerType("chatbot-inline-buttons", ChatBotInlineButtons);
};
