const { ApolloClient } = require("apollo-client");
// const { InMemoryCache } = require("apollo-cache-inmemory");
const { createHttpLink } = require("apollo-link-http");
const { ApolloLink, split } = require("apollo-link");
const { getMainDefinition } = require("apollo-utilities");
const _ = require("lodash");
const fetch = require("node-fetch").default;

module.exports = (RED) => {
  // const cache = new InMemoryCache();
  const host = !_.isEmpty(RED.settings.uiHost)
    ? RED.settings.uiHost
    : "localhost";
  const apolloLink = createHttpLink({
    uri: `http://${host}:${RED.settings.uiPort}/graphql`,
    fetch: fetch,
  });

  const link = split(({ query }) => {
    const definition = getMainDefinition(query);
    return (
      definition.kind === "OperationDefinition" &&
      definition.operation === "subscription"
    );
  }, apolloLink);

  return new ApolloClient({
    // cache,
    link: ApolloLink.from([link]),
  });
};
