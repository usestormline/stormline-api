# Chainlink feed mappings

Each `feeds.{chainId}.json` file maps an EIP-55 Stock Token contract address to
an EIP-55 Chainlink feed proxy address on the same Robinhood network.

Only add addresses copied from Chainlink's official Price Feeds page for that
network and independently verify the network and proxy contract. Leave the map
empty when no verified feed is published. Feed decimals are always read from
the proxy's `decimals()` function during registry sync; they must not be added
to these files or assumed in code.