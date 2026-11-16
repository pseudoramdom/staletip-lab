"""Network-specific lifecycle and mining operations live behind this interface.

A custom signet adapter can supply challenge arguments and a signing/grinding
miner without changing the controller, capture reader, HTTP API, or interface.
"""

from abc import ABC, abstractmethod


class Network(ABC):
    genesis = None
    name = ""
    chain_directory = ""
    persistent = False
    mining = False
    public_peers = False

    @abstractmethod
    def arguments(self):
        raise NotImplementedError

    def mine(self, node, count, tag):
        raise ValueError("Mining and fork creation are available only on regtest")

    def capabilities(self):
        return {"mining": self.mining, "forks": self.mining, "bootstrap": self.mining,
                "public_peers": self.public_peers, "persistent": self.persistent}


class Regtest(Network):
    name = "regtest"
    chain_directory = "regtest"
    mining = True

    def arguments(self):
        return ["-regtest"]

    def mine(self, node, count, tag):
        # Unique coinbase outputs keep independently mined branches distinct,
        # including two miners extending the same parent in the same second.
        script = "6a20" + tag
        return node.rpc("generatetodescriptor", count, "raw(%s)" % script)


class Testnet4(Network):
    name = "testnet4"
    chain_directory = "testnet4"
    persistent = True
    public_peers = True

    def arguments(self):
        return ["-testnet4"]


class Testnet5(Network):
    genesis = "00000000000008c1637e7d3252dc1c333d4546fd6fff6a474b200d674a91d497"
    name = "testnet5"
    chain_directory = "testnet5"
    persistent = True
    public_peers = True

    def arguments(self):
        return ["-testnet5"]


class Signet(Network):
    persistent = True
    public_peers = True
    name = "signet"
    chain_directory = "signet"

    def arguments(self):
        return ["-signet"]
