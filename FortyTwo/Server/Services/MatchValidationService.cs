using FortyTwo.Entity.Models;
using FortyTwo.Server.Exceptions;
using FortyTwo.Shared.Models;
using FortyTwo.Shared.Models.Security;
using PluralizeService.Core;
using System.Linq;

namespace FortyTwo.Server.Services
{
    public class MatchValidationService : IMatchValidationService
    {
        public IMatchValidationService IsNotNull(Match match)
        {
            if (match == null)
                throw new CustomValidationException("Match not found!");

            return this;
        }

        public IMatchValidationService IsActive(Match match)
        {
            IsNotNull(match);

            if (match.WinningTeam != null)
                throw new CustomValidationException("This match is over");

            return this;
        }

        public IMatchValidationService IsNotFull(Match match)
        {
            if (match.Players.Count >= 4)
                throw new CustomValidationException("Match is full", "This match already has enough players");

            return this;
        }

        public IMatchValidationService IsActive(MatchPlayer matchPlayer)
        {
            if (matchPlayer == null)
                throw new CustomValidationException("Player not found!");

            return this;
        }

        public IMatchValidationService IsNotNull(Game game)
        {
            if (game == null)
                throw new CustomValidationException("Game not found!");

            return this;
        }

        public IMatchValidationService IsActive(Game game)
        {
            IsNotNull(game);

            if (game.WinningTeam != null)
                throw new CustomValidationException("This game is over");

            return this;
        }

        public IMatchValidationService IsActiveTurn(Game game, UserId userId)
        {
            if (game.CurrentPlayerId != userId)
                throw new CustomValidationException("It's not your turn!");

            return this;
        }

        public IMatchValidationService IsActiveBidder(Game game, UserId userId)
        {
            var biddingTeam = game.Hands.First(x => x.PlayerId == game.BiddingPlayerId)?.Team;
            if ((game.Bid != Bid.Plunge && game.BiddingPlayerId != userId)
                || (game.Bid == Bid.Plunge && (game.BiddingPlayerId == userId || game.Hands.First(x => x.PlayerId == userId).Team != biddingTeam)))
                throw new CustomValidationException("It's not your turn!");

            return this;
        }

        public IMatchValidationService ValidateBid(Game game, UserId userId, Bid bid)
        {
            if (game.Hands.First(x => x.PlayerId == userId).Bid.HasValue)
                throw new CustomValidationException("Invalid Action", "You have already submitted a bid!");

            if (bid != Bid.Pass && game.Bid.HasValue && game.Bid >= bid)
                throw new CustomValidationException("Insufficient bid!",
                    $"A new bid must be hight than the current bid of <code>{game.Bid.Value.ToPrettyString()}</code>");

            if (game.Hands.Count(x => x.Bid == Bid.Pass) == 3 && bid == Bid.Pass)
                throw new CustomValidationException("Invalid Bid", "Everyone can't pass! You have to bid 😅");

            return this;
        }

        public IMatchValidationService BiddingComplete(Game game)
        {
            if (game.Hands.Any(x => !x.Bid.HasValue))
                throw new CustomValidationException("Invalid Action", "We're still bidding!");

            return this;
        }

        public IMatchValidationService IsReadyToPlay(Game game)
        {
            BiddingComplete(game);

            if (!game.Trump.HasValue)
                throw new CustomValidationException("Invalid Action", "We're still bidding!");

            return this;
        }

        public IMatchValidationService HasDomino(Game game, UserId userId, Domino domino)
        {
            if (!game.Hands.First(x => x.PlayerId == userId).Dominos.Contains(domino))
                throw new CustomValidationException("Invalid Domino");

            return this;
        }

        public IMatchValidationService IsValidDomino(Game game, UserId userId, Domino domino)
        {
            if (game.CurrentTrick.Suit.HasValue
                && !domino.IsOfSuit(game.CurrentTrick.Suit.Value, game.Trump)
                && game.Hands.First(x => x.PlayerId == userId).Dominos.Any(x => x.IsOfSuit(game.CurrentTrick.Suit.Value, game.Trump)))
                throw new CustomValidationException("You must follow suit!",
                    $"If you have a <code>{PluralizationProvider.Singularize(game.CurrentTrick.Suit.ToString())}</code>, you must play it");

            return this;
        }

        public IMatchValidationService IsMatchPlayer(Match match, UserId userId)
        {
            if (match.Players.All(x => x.PlayerId != userId))
                throw new CustomValidationException("You aren't a part of this match!");

            return this;
        }

        public IMatchValidationService IsNotMatchPlayer(Match match, UserId userId)
        {
            if (match.Players.Any(x => x.PlayerId == userId))
                throw new CustomValidationException("You are already in this match!");

            return this;
        }
    }
}
