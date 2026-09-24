using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using FortyTwo.Shared.Models;
using Xunit;

namespace FortyTwo.Tests.Characterization
{
    public class PlungeScenarioTests
    {
        // p1 (position First, TeamA) bids Plunge as their OPENING bid - MatchValidationService.ValidateBid
        // only blocks a non-Pass bid when a current bid already exists (game.Bid.HasValue), so bidding
        // Plunge (169) with nothing on the table yet is legal.
        //
        // Once all 4 bids are in, MatchService.BidAsync's Plunge branch hands CurrentPlayerId to the
        // BIDDER'S PARTNER (position+2), not the bidder: p1 is position First (0), so the partner is
        // position Third (2) = p3. p3 - not p1 - must call SetTrumpForCurrentGameAsync
        // (MatchValidationService.IsActiveBidder specifically rejects the original Plunge bidder) and
        // p3 leads the first trick.
        //
        // p3 gets all 7 doubles so they can lead each trick with an unbeatable trump double (same trick
        // as StandardGameScenarioTests, just moved to p3). Trump is Suit.Sixes, so 6-6/5-5 leads win
        // outright. Turn order after p3 leads is the normal (non-Low) rotation: p3 -> p4 -> p1 -> p2.
        // p1, p2, and p4 each hold a domino of the led suit for both tricks so they can follow suit.
        private static readonly List<(int, int)> DealOrder = new()
        {
            (0,1),(0,2),(0,3),(0,4),(0,5),(0,6),(1,2),           // p1
            (1,3),(1,4),(1,5),(1,6),(2,3),(2,4),(2,5),           // p2
            (0,0),(1,1),(2,2),(3,3),(4,4),(5,5),(6,6),           // p3: all doubles (Plunge bidder's partner)
            (2,6),(3,4),(3,5),(3,6),(4,5),(4,6),(5,6),           // p4
        };

        [Fact]
        public async Task RunAndWriteFixture()
        {
            var runner = new ScenarioRunner(DealOrder, "plunge-game");

            var matchId = await runner.CreateAsync("p1");
            await runner.AddPlayerAsync(matchId, "p2", Teams.TeamB);
            await runner.AddPlayerAsync(matchId, "p3", Teams.TeamA);
            await runner.AddPlayerAsync(matchId, "p4", Teams.TeamB);

            // p1 opens with Plunge (legal as a first bid - no current bid to out-bid yet).
            // p2/p3/p4 all pass; the "everyone can't pass" guard only blocks a 4th Pass when the
            // running bid is itself Pass, which isn't the case here (running bid is p1's Plunge).
            await runner.BidAsync(matchId, "p1", Bid.Plunge);
            await runner.BidAsync(matchId, "p2", Bid.Pass);
            await runner.BidAsync(matchId, "p3", Bid.Pass);
            await runner.BidAsync(matchId, "p4", Bid.Pass);

            // Confirm the Plunge rule fired: control passes to p1's PARTNER (p3), not p1, before
            // trump is even set. Assert this from real match state, before writing the fixture.
            var match = await runner.GetMatchAsync(matchId);
            var p3Id = match.Players.First(x => x.PlayerId == "p3").PlayerId;
            Assert.Equal(p3Id, match.CurrentGame.CurrentPlayerId);
            Assert.NotEqual("p1", match.CurrentGame.CurrentPlayerId);

            // p3 (the partner) sets trump - NOT p1, who would be rejected by IsActiveBidder for a
            // Plunge-winning bid.
            await runner.SetTrumpAsync(matchId, "p3", Suit.Sixes);

            // Trick 1: p3 leads 6-6 (trump double, wins). Turn order: p3 -> p4 -> p1 -> p2.
            await runner.PlayDominoAsync(matchId, "p3", 6, 6);
            await runner.PlayDominoAsync(matchId, "p4", 2, 6);
            await runner.PlayDominoAsync(matchId, "p1", 0, 6);
            await runner.PlayDominoAsync(matchId, "p2", 1, 6);

            // Trick 2: p3 leads again (won trick 1), 5-5.
            await runner.PlayDominoAsync(matchId, "p3", 5, 5);
            await runner.PlayDominoAsync(matchId, "p4", 3, 5);
            await runner.PlayDominoAsync(matchId, "p1", 0, 5);
            await runner.PlayDominoAsync(matchId, "p2", 1, 5);

            runner.WriteFixture();
        }
    }
}
