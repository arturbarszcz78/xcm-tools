/* eslint-disable @typescript-eslint/no-explicit-any */
import type { TAssetInfo } from '@paraspell/assets'
import { isAssetEqual } from '@paraspell/assets'
import type { TChain, TLocation, TSubstrateChain } from '@paraspell/sdk-common'
import { replaceBigInt } from '@paraspell/sdk-common'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { PolkadotApi } from '../../../api'
import { AmountTooLowError, DryRunFailedError, RoutingResolutionError } from '../../../errors'
import * as dryRunModule from '../../../transfer/dry-run/dryRunInternal'
import type { TCreateSwapXcmOptions, TExchangeChain } from '../../../types'
import { type TDryRunResult } from '../../../types'
import { createSwapExecuteXcm } from './createSwapExecuteXcm'
import { handleSwapExecuteTransfer } from './handleSwapExecuteTransfer'

vi.mock('../../fees/padFee', () => ({
  padValueBy: (fee: bigint) => fee + 10n
}))

vi.mock('../../chain', () => ({
  getChainVersion: () => 2,
  getRelayChainOf: () => 'Polkadot'
}))

vi.mock('./createExecuteCall', () => ({
  createExecuteCall: (xcm: any, weight: bigint) => ({ xcm, weight, call: true })
}))

vi.mock('./createSwapExecuteXcm', () => ({
  createSwapExecuteXcm: vi.fn()
}))

vi.mock('./isMultiHopSwap', () => ({
  isMultiHopSwap: () => true
}))

vi.mock('../../../chains/config')

vi.mock('@paraspell/assets', () => ({
  hasXcmPaymentApiSupport: vi.fn().mockReturnValue(true),
  findNativeAssetInfoOrThrow: vi.fn(),
  isAssetEqual: vi.fn().mockReturnValue(true)
}))

const mockApi = {
  init: vi.fn(),
  getXcmWeight: vi.fn(),
  deserializeExtrinsics: vi.fn(),
  hasXcmPaymentApiSupport: vi.fn().mockReturnValue(true),
  findNativeAssetInfoOrThrow: vi.fn()
} as unknown as PolkadotApi<unknown, unknown, unknown>

const ORIGIN_CHAIN: TSubstrateChain = 'Astar'
const EXCHANGE_CHAIN: TExchangeChain = 'Hydration'
const DEST_CHAIN: TChain = 'Darwinia'

const baseOptions = {
  api: mockApi,
  chain: ORIGIN_CHAIN,
  exchangeChain: EXCHANGE_CHAIN,
  destChain: DEST_CHAIN,
  assetInfoFrom: {
    amount: 2000n,
    location: {}
  },
  assetInfoTo: { location: {}, amount: 0n },
  sender: 'alice',
  recipient: 'bob',
  calculateMinAmountOut: vi.fn().mockResolvedValue(1500n)
} as unknown as TCreateSwapXcmOptions<unknown, unknown, unknown>

const mockDryRunResult = (success = true, includeOrigin = false) =>
  ({
    origin: {
      success: includeOrigin,
      fee: 500n,
      dryRunError: includeOrigin ? undefined : { reason: 'Origin failed' }
    },
    hops: [
      {
        chain: ORIGIN_CHAIN,
        result: {
          success: true,
          fee: 100n
        }
      },
      {
        chain: EXCHANGE_CHAIN,
        result: {
          success,
          fee: 200n,
          dryRunError: success ? undefined : { reason: 'Exchange failed' }
        }
      },
      {
        chain: DEST_CHAIN,
        result: {
          success: true,
          fee: 150n
        }
      }
    ]
  }) as unknown as TDryRunResult

describe('handleSwapExecuteTransfer', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    baseOptions.calculateMinAmountOut = vi.fn().mockResolvedValue(1500n)
    mockApi.deserializeExtrinsics = vi
      .fn()
      .mockImplementation(call => `tx:${JSON.stringify(call, replaceBigInt)}`)
    mockApi.getXcmWeight = vi.fn().mockResolvedValue(100000n)
    mockApi.init = vi.fn()
  })

  it('throws if initial amount is too low', async () => {
    const options = {
      ...baseOptions,
      assetInfoFrom: { ...baseOptions.assetInfoFrom, amount: 500n }
    }

    await expect(handleSwapExecuteTransfer(options)).rejects.toThrow(AmountTooLowError)
  })

  it('throws if dry run fails', async () => {
    vi.spyOn(dryRunModule, 'dryRunInternal').mockResolvedValueOnce(mockDryRunResult(false))

    await expect(handleSwapExecuteTransfer(baseOptions)).rejects.toThrow(DryRunFailedError)
  })

  it('throws if exchange hop is missing', async () => {
    const dryRunMissingExchange = {
      origin: { success: true, fee: 0n },
      hops: [
        { chain: ORIGIN_CHAIN, result: { success: true, fee: 0n } },
        { chain: DEST_CHAIN, result: { success: true, fee: 0n } }
      ]
    } as unknown as TDryRunResult

    vi.spyOn(dryRunModule, 'dryRunInternal').mockResolvedValue(dryRunMissingExchange)

    const options = {
      ...baseOptions,
      exchangeChain: EXCHANGE_CHAIN
    }

    await expect(handleSwapExecuteTransfer(options)).rejects.toThrow(RoutingResolutionError)
  })

  it('returns final tx call on success', async () => {
    baseOptions.calculateMinAmountOut = vi.fn().mockResolvedValue(1500n)

    vi.spyOn(dryRunModule, 'dryRunInternal')
      .mockResolvedValueOnce(mockDryRunResult(true, true))
      .mockResolvedValueOnce(mockDryRunResult(true, true))
      .mockResolvedValueOnce(mockDryRunResult(true, true))

    const initSpy = vi.spyOn(mockApi, 'init')

    const result = await handleSwapExecuteTransfer(baseOptions)

    expect(result).toMatch(/^tx:/)
    expect(initSpy).toHaveBeenCalled()
    expect(baseOptions.calculateMinAmountOut).toHaveBeenCalledWith(1680n)
  })

  it('handles case when exchange chain is final destination', async () => {
    const optionsNoDestChain = {
      ...baseOptions,
      destChain: undefined
    }

    const mockDryRunNoDestChain = {
      origin: { success: true, fee: 100n },
      destination: { success: true, fee: 300n },
      hops: []
    } as unknown as TDryRunResult

    vi.spyOn(dryRunModule, 'dryRunInternal')
      .mockResolvedValueOnce(mockDryRunNoDestChain)
      .mockResolvedValueOnce(mockDryRunNoDestChain)

    const result = await handleSwapExecuteTransfer(optionsNoDestChain)
    expect(result).toMatch(/^tx:/)
  })

  it('extracts origin reserve fee from last hop when no destChain', async () => {
    const optionsNoDestChain = {
      ...baseOptions,
      destChain: undefined
    }

    const mockDryRunWithHops = {
      origin: { success: true, fee: 100n },
      destination: { success: true, fee: 300n },
      hops: [
        {
          chain: ORIGIN_CHAIN,
          result: { success: true, fee: 150n }
        }
      ]
    } as unknown as TDryRunResult

    vi.spyOn(dryRunModule, 'dryRunInternal')
      .mockResolvedValueOnce(mockDryRunWithHops)
      .mockResolvedValueOnce(mockDryRunWithHops)

    const result = await handleSwapExecuteTransfer(optionsNoDestChain)
    expect(result).toMatch(/^tx:/)
    expect(baseOptions.calculateMinAmountOut).toHaveBeenCalledWith(1530n)
  })

  it('handles case when origin is exchange chain', async () => {
    const optionsNoChain = {
      ...baseOptions,
      chain: undefined,
      calculateMinAmountOut: vi.fn().mockResolvedValue(1500n)
    }

    const mockDryRunNoChain = {
      origin: { success: true, fee: 0n },
      hops: [
        {
          chain: DEST_CHAIN,
          result: { success: true, fee: 150n }
        }
      ]
    } as unknown as TDryRunResult

    vi.spyOn(dryRunModule, 'dryRunInternal')
      .mockResolvedValueOnce(mockDryRunNoChain)
      .mockResolvedValueOnce(mockDryRunNoChain)

    const result = await handleSwapExecuteTransfer(optionsNoChain)
    expect(result).toMatch(/^tx:/)
  })

  it('throws when origin dry run fails', async () => {
    const mockDryRunOriginFailed = {
      success: false,
      origin: {
        success: false,
        asset: {
          symbol: 'ACA',
          decimals: 12,
          existentialDeposit: '1000',
          location: { parents: 0, interior: 'Here' }
        },
        dryRunError: { reason: 'Origin execution failed' }
      },
      hops: []
    } as TDryRunResult

    vi.spyOn(dryRunModule, 'dryRunInternal').mockResolvedValueOnce(mockDryRunOriginFailed)

    await expect(handleSwapExecuteTransfer(baseOptions)).rejects.toThrow()
  })

  it('handles case when origin chain is same as exchange chain', async () => {
    const optionsSameChain = {
      ...baseOptions,
      chain: EXCHANGE_CHAIN
    }

    const mockDryRunSameChain = {
      origin: { success: true, fee: 100n },
      destination: { success: true, fee: 200n },
      hops: [
        {
          chain: EXCHANGE_CHAIN,
          result: { success: true, fee: 100n }
        },
        {
          chain: DEST_CHAIN,
          result: { success: true, fee: 150n }
        }
      ]
    } as unknown as TDryRunResult

    vi.spyOn(dryRunModule, 'dryRunInternal')
      .mockResolvedValueOnce(mockDryRunSameChain)
      .mockResolvedValueOnce(mockDryRunSameChain)

    const result = await handleSwapExecuteTransfer(optionsSameChain)
    expect(result).toMatch(/^tx:/)
  })

  describe('separate fee asset', () => {
    const feeAssetInfo = {
      symbol: 'USDC',
      decimals: 6,
      location: { parents: 1, interior: 'Here' }
    } as TAssetInfo

    const dryRunWithDest = {
      ...mockDryRunResult(true, true),
      destination: { success: true, fee: 300n }
    } as unknown as TDryRunResult

    it('uses a generous fee asset budget for the first dry run and the extracted fees after', async () => {
      vi.mocked(isAssetEqual).mockReturnValue(false)
      const dryRunSpy = vi.spyOn(dryRunModule, 'dryRunInternal').mockResolvedValue(dryRunWithDest)
      const options = { ...baseOptions, feeAssetInfo }

      await handleSwapExecuteTransfer(options)

      expect(dryRunSpy).toHaveBeenCalledWith(
        expect.objectContaining({ feeAsset: { location: feeAssetInfo.location } })
      )

      const dummy = 100_000_000n
      const [firstCall, finalCall] = vi.mocked(createSwapExecuteXcm).mock.calls
      expect(firstCall[0].fees).toEqual({
        originFee: dummy,
        originReserveFee: dummy,
        exchangeFee: dummy,
        destReserveFee: dummy,
        destFee: dummy
      })
      expect(finalCall[0].fees).toEqual({
        originFee: 510n,
        originReserveFee: 110n,
        exchangeFee: 210n,
        destReserveFee: 160n,
        destFee: 310n
      })
      expect(options.calculateMinAmountOut).toHaveBeenCalledWith(2000n)
    })

    it('surfaces the dry run failure instead of an amount error when fees are paid separately', async () => {
      vi.mocked(isAssetEqual).mockReturnValue(false)
      const failed = {
        ...mockDryRunResult(true, true),
        dryRunError: { chainKind: 'hop', chain: EXCHANGE_CHAIN, reason: 'NotHoldingFees' }
      } as unknown as TDryRunResult
      vi.spyOn(dryRunModule, 'dryRunInternal').mockResolvedValue(failed)

      await expect(handleSwapExecuteTransfer({ ...baseOptions, feeAssetInfo })).rejects.toThrow(
        DryRunFailedError
      )
    })

    it('keeps minimal dummy fees on the destination leg when the fee asset is the swapped asset', async () => {
      vi.mocked(isAssetEqual).mockImplementation(asset => asset === baseOptions.assetInfoTo)
      vi.spyOn(dryRunModule, 'dryRunInternal').mockResolvedValue(dryRunWithDest)
      const options = { ...baseOptions, feeAssetInfo }

      await handleSwapExecuteTransfer(options)

      const [firstCall] = vi.mocked(createSwapExecuteXcm).mock.calls
      const dummy = 100_000_000n
      expect(firstCall[0].fees).toEqual({
        originFee: dummy,
        originReserveFee: dummy,
        exchangeFee: dummy,
        destReserveFee: 1000n,
        destFee: 1000n
      })
    })

    it('ignores a fee asset equal to the swapped asset', async () => {
      vi.mocked(isAssetEqual).mockReturnValue(true)
      vi.spyOn(dryRunModule, 'dryRunInternal').mockResolvedValue(dryRunWithDest)
      const options = { ...baseOptions, feeAssetInfo }

      await handleSwapExecuteTransfer(options)

      const [firstCall, finalCall] = vi.mocked(createSwapExecuteXcm).mock.calls
      expect(firstCall[0].fees).toEqual({
        originFee: 0n,
        originReserveFee: 1000n,
        exchangeFee: 0n,
        destReserveFee: 1000n,
        destFee: 1000n
      })
      expect(finalCall[0].fees.originFee).toBe(0n)
      expect(options.calculateMinAmountOut).toHaveBeenCalledWith(1680n)
    })
  })

  describe('Ethereum destination', () => {
    const LOCATION: TLocation = { parents: 0, interior: 'Here' }

    const dotAssetInfo: TAssetInfo = {
      symbol: 'DOT',
      decimals: 10,
      existentialDeposit: '1000',
      location: LOCATION
    }

    const ethOptions = {
      ...baseOptions,
      chain: undefined,
      exchangeChain: 'Hydration' as TExchangeChain,
      destChain: 'Ethereum' as TChain,
      assetInfoFrom: {
        ...dotAssetInfo,
        amount: 5000n
      },
      assetInfoTo: {
        symbol: 'WETH',
        decimals: 18,
        existentialDeposit: '1000',
        amount: 0n,
        location: LOCATION
      },
      currencyTo: { symbol: 'WETH' }
    }

    const mockDryRunEth = {
      origin: { success: true, fee: 0n },
      hops: [
        {
          chain: 'AssetHubPolkadot',
          result: { success: true, fee: 50n }
        },
        {
          chain: 'BridgeHubPolkadot',
          result: { success: true, fee: 70n }
        }
      ]
    } as unknown as TDryRunResult

    it('extracts destReserveFee and destFee from hops and deducts total fees from amountAvailableForSwap when swapping native DOT from exchangeChain', async () => {
      vi.mocked(isAssetEqual).mockImplementation((a: TAssetInfo, b?: TAssetInfo) => a.symbol === b?.symbol)
      vi.spyOn(mockApi, 'findNativeAssetInfoOrThrow').mockReturnValue(dotAssetInfo)
      vi.spyOn(dryRunModule, 'dryRunInternal').mockResolvedValue(mockDryRunEth)

      await handleSwapExecuteTransfer(ethOptions)

      // Pad fee adds 10n in mock:
      // hop 0 (AssetHubPolkadot): 50n + 10n = 60n (destReserveFee)
      // hop 1 (BridgeHubPolkadot): 70n + 10n = 80n (destFee)
      // totalFees = 60n + 80n = 140n
      // amountAvailableForSwap = 5000n - 140n = 4860n
      expect(ethOptions.calculateMinAmountOut).toHaveBeenCalledWith(4860n)

      const [, finalCall] = vi.mocked(createSwapExecuteXcm).mock.calls
      expect(finalCall[0].fees.destReserveFee).toBe(60n)
      expect(finalCall[0].fees.destFee).toBe(80n)
    })

    it('extracts fees from hops and deducts pre-swap and post-swap fees when origin is a parachain', async () => {
      vi.mocked(isAssetEqual).mockImplementation((a: TAssetInfo, b?: TAssetInfo) => a.symbol === b?.symbol)
      vi.spyOn(mockApi, 'findNativeAssetInfoOrThrow').mockReturnValue(dotAssetInfo)

      const parachainEthOptions = {
        ...ethOptions,
        chain: 'Astar' as TSubstrateChain,
        calculateMinAmountOut: vi.fn().mockResolvedValue(1500n)
      }

      const mockDryRunParachainToEth = {
        origin: { success: true, fee: 100n },
        hops: [
          { chain: 'Astar', result: { success: true, fee: 20n } },
          { chain: 'Hydration', result: { success: true, fee: 40n } },
          { chain: 'AssetHubPolkadot', result: { success: true, fee: 60n } },
          { chain: 'BridgeHubPolkadot', result: { success: true, fee: 80n } }
        ]
      } as unknown as TDryRunResult

      vi.spyOn(dryRunModule, 'dryRunInternal').mockResolvedValue(mockDryRunParachainToEth)

      await handleSwapExecuteTransfer(parachainEthOptions)

      // originReserveFee: 20n + 10n = 30n
      // exchangeFee: 40n + 10n = 50n
      // destReserveFee: 60n + 10n = 70n
      // destFee: 80n + 10n = 90n
      // preSwap = 80n, postSwap = 160n, total = 240n
      // amountAvailableForSwap = 5000n - 240n = 4760n
      expect(parachainEthOptions.calculateMinAmountOut).toHaveBeenCalledWith(4760n)

      const [, finalCall] = vi.mocked(createSwapExecuteXcm).mock.calls
      expect(finalCall[0].fees.originReserveFee).toBe(30n)
      expect(finalCall[0].fees.exchangeFee).toBe(50n)
      expect(finalCall[0].fees.destReserveFee).toBe(70n)
      expect(finalCall[0].fees.destFee).toBe(90n)
    })

    it('handles case where hops.length === exchangeHopIndex + 2 (single destination hop to BridgeHub)', async () => {
      vi.mocked(isAssetEqual).mockImplementation((a: TAssetInfo, b?: TAssetInfo) => a.symbol === b?.symbol)
      vi.spyOn(mockApi, 'findNativeAssetInfoOrThrow').mockReturnValue(dotAssetInfo)

      const directHubOptions = {
        ...ethOptions,
        chain: undefined,
        exchangeChain: 'AssetHubPolkadot' as TExchangeChain,
        calculateMinAmountOut: vi.fn().mockResolvedValue(1500n)
      }

      const mockSingleHopEth = {
        origin: { success: true, fee: 0n },
        hops: [{ chain: 'BridgeHubPolkadot', result: { success: true, fee: 50n } }]
      } as unknown as TDryRunResult

      vi.spyOn(dryRunModule, 'dryRunInternal').mockResolvedValue(mockSingleHopEth)

      await handleSwapExecuteTransfer(directHubOptions)

      // exchangeHopIndex = -1, hops.length = 1 === -1 + 2
      // destFee = 50n + 10n = 60n, destReserveFee = 0n
      // totalFees = 60n
      // amountAvailableForSwap = 5000n - 60n = 4940n
      expect(directHubOptions.calculateMinAmountOut).toHaveBeenCalledWith(4940n)

      const [, finalCall] = vi.mocked(createSwapExecuteXcm).mock.calls
      expect(finalCall[0].fees.destReserveFee).toBe(0n)
      expect(finalCall[0].fees.destFee).toBe(60n)
    })

    it('does not deduct post-swap Ethereum bridge fees from assetFrom when paying fees with a separate fee asset', async () => {
      vi.mocked(isAssetEqual).mockReturnValue(false) // USDC !== DOT, so hasSeparateFeeAsset = true
      vi.spyOn(mockApi, 'findNativeAssetInfoOrThrow').mockReturnValue(dotAssetInfo)

      const separateFeeEthOptions = {
        ...ethOptions,
        chain: 'Astar' as TSubstrateChain,
        assetInfoFrom: {
          symbol: 'USDC',
          decimals: 6,
          existentialDeposit: '1000',
          amount: 5000n,
          location: LOCATION
        },
        calculateMinAmountOut: vi.fn().mockResolvedValue(1500n)
      }

      const mockDryRunParachainToEth = {
        origin: { success: true, fee: 100n },
        hops: [
          { chain: 'Astar', result: { success: true, fee: 20n } },
          { chain: 'Hydration', result: { success: true, fee: 40n } },
          { chain: 'AssetHubPolkadot', result: { success: true, fee: 60n } },
          { chain: 'BridgeHubPolkadot', result: { success: true, fee: 80n } }
        ]
      } as unknown as TDryRunResult

      vi.spyOn(dryRunModule, 'dryRunInternal').mockResolvedValue(mockDryRunParachainToEth)

      await handleSwapExecuteTransfer(separateFeeEthOptions)

      // hasSeparateFeeAsset is true, so full amount is available for swap
      expect(separateFeeEthOptions.calculateMinAmountOut).toHaveBeenCalledWith(5000n)
    })
  })
})
