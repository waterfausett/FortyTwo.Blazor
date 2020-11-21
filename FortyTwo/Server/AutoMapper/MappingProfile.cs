using AutoMapper;
using FortyTwo.Shared.Models;

namespace FortyTwo.Server.AutoMapper
{
    public class MappingProfile : Profile
    {
        public MappingProfile()
        {
            CreateMap<Player, Models.DTO.Player>()
                .ForMember(dest => dest.Dominos, opt => opt.MapFrom(src => src.Dominos.Count));

            CreateMap<GameContext, Models.DTO.Game>();
        }
    }
}
